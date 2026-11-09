param([Parameter(Mandatory=$true)][string]$ExpectedPath)
$ErrorActionPreference = 'Stop'
$expected = Get-Content -LiteralPath $ExpectedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$report = [ordered]@{}
Add-Type -AssemblyName System.Windows.Forms

try {
    $editor = New-Object System.Windows.Forms.TextBox
    $editor.Multiline = $true
    $null = $editor.Handle
    $editor.Paste()
    if ($editor.Text -cne $expected.plain) { throw 'The Windows plain-text control did not receive the expected TSV.' }
    $report.plainTextControl = @{ passed = $true; detail = 'Native TextBox.Paste received the exact TSV fallback.' }
} catch {
    $report.plainTextControl = @{ passed = $false; error = $_.Exception.Message }
} finally {
    if ($editor) { $editor.Dispose() }
}

$excel = $null
$book = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $book = $excel.Workbooks.Add()
    $sheet = $book.Worksheets.Item(1)
    $null = $sheet.Range('A1').Select()
    $sheet.Paste()
    if ($sheet.Range('A1').Text -cne 'Name') { throw 'Excel header did not paste correctly.' }
    if ($sheet.Range('A1').MergeArea.Rows.Count -ne 2) { throw 'Excel did not preserve the vertical header merge.' }
    if ($sheet.Range('B1').MergeArea.Columns.Count -ne 2) { throw 'Excel did not preserve the horizontal header merge.' }
    if ($sheet.Range('A3').Text -cne 'Ada & Co') { throw 'Excel body text did not paste correctly.' }
    if ($sheet.Range('A3').MergeArea.Rows.Count -ne 2) { throw 'Excel did not preserve the body rowspan.' }
    if ($sheet.Range('B4').MergeArea.Columns.Count -ne 2) { throw 'Excel did not preserve the body colspan.' }
    if ($sheet.Range('A5').Text -cne 'Grace') { throw 'Excel last row did not paste correctly.' }
    if ($sheet.Range('C5').Text -cne $expected.unicode) { throw 'Excel Unicode did not paste correctly.' }
    $report.excel = @{ passed = $true; version = $excel.Version; detail = 'HTML paste preserved data and horizontal/vertical header and body merges.' }
} catch {
    $report.excel = @{ passed = $false; error = $_.Exception.Message }
} finally {
    if ($book) { $book.Close($false) }
    if ($excel) { $excel.Quit(); $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) }
}

$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $doc = $word.Documents.Add()
    $doc.Content.Paste()
    if ($doc.Tables.Count -ne 1) { throw 'Word did not receive a table.' }
    $table = $doc.Tables.Item(1)
    if ($table.Cell(1, 1).Range.Text.Trim([char[]]@(13, 7)) -cne 'Name') { throw 'Word header did not paste correctly.' }
    if ($table.Range.Text -notmatch 'Ada & Co' -or $table.Range.Text -notmatch 'Grace') { throw 'Word body rows did not paste correctly.' }
    if ($table.Cell(1, 1).Range.Bold -ne -1) { throw 'Word header formatting did not remain bold.' }
    if (-not $table.Range.Text.Contains($expected.unicode)) { throw 'Word Unicode did not paste correctly.' }
    $report.word = @{ passed = $true; version = $word.Version; detail = 'Native paste created a table with the expected headers, body text, and bold header formatting.' }
} catch {
    $report.word = @{ passed = $false; error = $_.Exception.Message }
} finally {
    if ($doc) { $doc.Close(0) }
    if ($word) { $word.Quit(); $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
}
$report.googleSheets = @{ tested = $false; reason = 'No authenticated browser or connected Sheets session is available.' }
$report.notepad = @{ tested = $false; reason = 'A native Windows plain-text control was exercised instead of the Notepad application.' }
$report | ConvertTo-Json -Depth 5

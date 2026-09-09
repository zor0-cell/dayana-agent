$shell = New-Object -ComObject WScript.Shell
$paths = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  "$env:USERPROFILE\Desktop",
  "$env:PUBLIC\Desktop"
)
$results = foreach ($p in $paths) {
  Get-ChildItem -Path $p -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $sc = $shell.CreateShortcut($_.FullName)
    [PSCustomObject]@{ Name = $_.BaseName; Target = $sc.TargetPath }
  }
}
$results | ConvertTo-Json -Compress
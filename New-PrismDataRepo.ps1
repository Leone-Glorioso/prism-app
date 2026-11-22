#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a local Git repository for the private "prism-data" repo from the migrated Prism projects.

.DESCRIPTION
  Copies each project folder from "Prism Projects\" (following the thesis junction, so the real
  thesis files are copied), skips build\ folders, verifies every copied file by SHA-256, writes the
  manifest with forward-slash paths, adds the compile workflow, and makes one local commit.
  It never pushes and never modifies the source folders.

.EXAMPLE
  ./New-PrismDataRepo.ps1 -Destination "$env:TEMP\prism-data"
.EXAMPLE
  ./New-PrismDataRepo.ps1 -Destination "$env:TEMP\prism-data-test" -Projects 'MSc Thesis 3.0','ADS Exercise 2','Academic CV'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Destination,
  [string[]] $Projects,
  [string] $WorkspaceRoot = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = 'Stop'

$source = Join-Path $WorkspaceRoot 'Prism Projects'
$manifestPath = Join-Path $WorkspaceRoot 'prism-projects.json'
$template = Join-Path $PSScriptRoot 'data-repo'
foreach ($p in $source, $manifestPath, $template) { if (-not (Test-Path $p)) { throw "Not found: $p" } }
if ((Test-Path $Destination) -and (Get-ChildItem -Force $Destination | Select-Object -First 1)) {
  throw "Destination exists and is not empty: $Destination"
}

# ForEach-Object unrolls the array (Windows PowerShell 5.1 emits a JSON array as one object).
$manifest = @((Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json) | ForEach-Object { $_ })
if ($Projects) {
  $unknown = $Projects | Where-Object { $_ -notin $manifest.Project }
  if ($unknown) { throw "Not in manifest: $($unknown -join ', ')" }
  $manifest = @($manifest | Where-Object { $_.Project -in $Projects })
}

New-Item -ItemType Directory -Force $Destination | Out-Null
$Destination = (Resolve-Path $Destination).Path
$copied = 0
foreach ($entry in $manifest) {
  $name = $entry.Project
  $from = Join-Path $source $name
  if (-not (Test-Path $from -PathType Container)) { Write-Warning "Project folder missing, skipped: $name"; continue }
  $to = Join-Path $Destination $name
  # robocopy follows directory junctions by default; /XD build skips generated outputs.
  robocopy $from $to /E /XD build /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) for $name" }

  # Verify: every source file (outside build\ folders) exists in the copy with the same hash.
  # .NET enumeration follows junctions (Get-ChildItem -Recurse in 5.1 does not), matching robocopy.
  $srcFiles = @([IO.Directory]::EnumerateFiles($from, '*', [IO.SearchOption]::AllDirectories) | Where-Object {
    -not ($_.Substring($from.Length) -split '[\\/]' | Where-Object { $_ -eq 'build' })
  })
  foreach ($f in $srcFiles) {
    $rel = $f.Substring($from.Length).TrimStart('\', '/')
    $dst = Join-Path $to $rel
    if (-not (Test-Path -LiteralPath $dst)) { throw "Missing after copy: $name\$rel" }
    if ((Get-FileHash -LiteralPath $f).Hash -ne (Get-FileHash -LiteralPath $dst).Hash) {
      throw "Hash mismatch after copy: $name\$rel"
    }
  }
  $dstCount = @([IO.Directory]::EnumerateFiles($to, '*', [IO.SearchOption]::AllDirectories)).Count
  if ($dstCount -ne $srcFiles.Count) { throw "File count differs for ${name}: source $($srcFiles.Count), copy $dstCount" }
  $copied += $srcFiles.Count
}

foreach ($entry in $manifest) { $entry.MainFile = $entry.MainFile -replace '\\', '/' }
$json = ConvertTo-Json -InputObject $manifest -Depth 6
[IO.File]::WriteAllText((Join-Path $Destination 'prism-projects.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
Copy-Item -Force (Join-Path $template '.gitignore') $Destination
Copy-Item -Recurse -Force (Join-Path $template '.github') $Destination

Push-Location $Destination
try {
  git init -q -b main
  git config core.autocrlf false   # keep file bytes exactly as copied
  git add -A
  $ignored = @(git ls-files --others --ignored --exclude-standard)
  git commit -q -m "Import migrated Prism projects"
  $tracked = (git ls-files | Measure-Object).Count
} finally { Pop-Location }

Write-Host "Projects: $($manifest.Count); source files copied and hash-verified: $copied; tracked in Git: $tracked"
if ($ignored.Count) {
  Write-Host "Copied but not committed (LaTeX intermediates matched by .gitignore): $($ignored.Count)"
  $ignored | ForEach-Object { Write-Host "  $_" }
}
Write-Host "Local repository ready at: $Destination (nothing pushed)."

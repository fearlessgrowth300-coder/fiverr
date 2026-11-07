$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    throw 'An .env already exists. Edit that file locally instead of overwriting its credentials.'
}
$secret = Read-Host 'Paste your Apify API token (hidden; Enter to configure later)' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
if ($token -match '[\r\n"'']') { throw 'Unexpected characters in token.' }
$bytes = New-Object byte[] 24
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$workspaceKey = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
$config = "APIFY_TOKEN=$token`nWORKSPACE_KEY=$workspaceKey`nHOST=127.0.0.1`nPORT=8787`nMAX_RUN_CHARGE_USD=0.50`nMAX_RUNS_PER_DAY=10`nMAX_CONCURRENT_RUNS=2`n"
[IO.File]::WriteAllText($envPath, $config, [Text.UTF8Encoding]::new($false))
$token = $null
$config = $null
$claude = @{ mcpServers = @{ 'fiverr-gig-studio' = @{ command = 'node'; args = @("--env-file=$envPath", (Join-Path $projectRoot 'src\index.js'), '--stdio') } } }
$claude | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $projectRoot 'claude-desktop.example.json') -Encoding utf8
Write-Host 'Created .env and claude-desktop.example.json. Your token was not printed.'
Write-Host 'Open .env locally to retrieve WORKSPACE_KEY for your private ChatGPT/Claude chat. Keep APIFY_TOKEN on the server.'
Write-Host 'Start HTTP with npm start, or use the generated Claude Desktop configuration.'

param([switch] $Configure)

$ErrorActionPreference = 'Stop'
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'Alicecode'
$credentialPath = Join-Path $credentialDirectory 'yandex-ai-studio.xml'

if ($Configure) {
    $folderId = (Read-Host 'Yandex AI Studio folder ID').Trim()
    if ($folderId -notmatch '^[a-zA-Z0-9_-]+$') {
        throw 'Enter the AI Studio folder ID.'
    }
    $apiKey = Read-Host 'Yandex AI Studio API key (hidden)' -AsSecureString
    if ($apiKey.Length -eq 0) {
        throw 'The API key is empty.'
    }
    $null = New-Item -ItemType Directory -Path $credentialDirectory -Force
    [pscredential]::new($folderId, $apiKey) | Export-Clixml -LiteralPath $credentialPath
    Write-Host 'Credentials saved for this Windows account.'
    return
}

$loadedCredentials = -not ($env:YANDEX_FOLDER_ID -and $env:YANDEX_API_KEY)
if ($loadedCredentials) {
    if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        throw 'Set YANDEX_FOLDER_ID and YANDEX_API_KEY, or run .\run-alice.ps1 -Configure.'
    }
    $credential = Import-Clixml -LiteralPath $credentialPath
    $previousFolderId = $env:YANDEX_FOLDER_ID
    $previousApiKey = $env:YANDEX_API_KEY
    $env:YANDEX_FOLDER_ID = $credential.UserName
    $env:YANDEX_API_KEY = $credential.GetNetworkCredential().Password
}

try {
    node (Join-Path $PSScriptRoot 'run-alice.mjs')
    exit $LASTEXITCODE
} finally {
    if ($loadedCredentials) {
        $env:YANDEX_FOLDER_ID = $previousFolderId
        $env:YANDEX_API_KEY = $previousApiKey
    }
}

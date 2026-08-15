param(
    [string]$Repository = "byqianye/QX"
)

$ErrorActionPreference = "Stop"
$secretNames = @(
    "SIGNPATH_API_TOKEN",
    "SIGNPATH_ORGANIZATION_ID",
    "SIGNPATH_PROJECT_SLUG",
    "SIGNPATH_SIGNING_POLICY_SLUG"
)

$gh = (Get-Command gh.exe -ErrorAction Stop).Source
& $gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
    throw "GITHUB_AUTH_REQUIRED"
}

function Read-Required([string]$Prompt) {
    $value = Read-Host -Prompt $Prompt
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "EMPTY_VALUE: $Prompt"
    }
    return $value.Trim()
}

function Read-SecretPlainText([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Set-GhSecret([string]$Name, [string]$Value) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $gh
    $start.Arguments = "secret set $Name --repo $Repository"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    $process.StandardInput.Write($Value)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "GITHUB_SECRET_WRITE_FAILED: $Name $stderr $stdout"
    }
}

Write-Host "Repository: $Repository"
Write-Host "The API token is read without echo and is never written to a file."
$apiToken = Read-SecretPlainText "SignPath API token"
$organization = Read-Required "SignPath organization ID"
$project = Read-Required "SignPath project slug"
$policy = Read-Required "SignPath signing policy slug"

$values = @{
    SIGNPATH_API_TOKEN = $apiToken
    SIGNPATH_ORGANIZATION_ID = $organization
    SIGNPATH_PROJECT_SLUG = $project
    SIGNPATH_SIGNING_POLICY_SLUG = $policy
}
foreach ($name in $secretNames) {
    Set-GhSecret -Name $name -Value $values[$name]
    Write-Host "SET $name"
}

Write-Host "SIGNPATH_SECRETS_CONFIGURED"

param([Parameter(Mandatory=$true)][string]$Path)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Apple Inc\.(,|$)') {
  throw ('The Swift installer does not have a valid Apple Authenticode signature: ' + $signature.Status + '; ' + $signature.SignerCertificate.Subject)
}
@{
  status = [string]$signature.Status
  subject = $signature.SignerCertificate.Subject
  thumbprint = $signature.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress

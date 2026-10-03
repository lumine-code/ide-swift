param([Parameter(Mandatory=$true)][string]$Path)
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Apple Inc\.(,|$)') {
  throw 'The Swift installer does not have a valid Apple Authenticode signature.'
}
@{
  status = [string]$signature.Status
  subject = $signature.SignerCertificate.Subject
  thumbprint = $signature.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress

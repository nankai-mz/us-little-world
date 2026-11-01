$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22.12+ 或 24 LTS。' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  npm ci --registry=https://registry.npmjs.org
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
Write-Host 'Us 本机预览：http://127.0.0.1:5173/  （Ctrl+C 结束）'
npm run dev

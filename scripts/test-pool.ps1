# NexusTrade pool test betigi
$base = 'http://localhost:3000/api/dev/pool'
$instanceId = 'test-bot-1'

Write-Host "`n[1] Pool stats:" -ForegroundColor Cyan
Invoke-RestMethod "$base/stats" | ConvertTo-Json -Depth 10

Write-Host "`n[2] Strateji yukle:" -ForegroundColor Cyan
$body = @{ instance = $instanceId; strategy_file = 'rsi_mean_reversion.py' } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/load" -Method POST -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 10

Write-Host "`n[3] Tick (BTCUSDT 1h):" -ForegroundColor Cyan
$body = @{ instance = $instanceId; symbol = 'BTCUSDT'; interval = '1h'; limit = 200 } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/tick" -Method POST -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 10

Write-Host "`n[4] Pool stats (instance gozukmeli):" -ForegroundColor Cyan
Invoke-RestMethod "$base/stats" | ConvertTo-Json -Depth 10

Write-Host "`n[5] Drop:" -ForegroundColor Cyan
$body = @{ instance = $instanceId } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/drop" -Method POST -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 10

Write-Host "`nBitti." -ForegroundColor Green
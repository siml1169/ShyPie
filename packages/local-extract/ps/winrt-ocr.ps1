# WinRT OCR adapter for @shypie_privacy/local-extract.
#
# Runs entirely offline: Windows.Media.Ocr is a local OS component. No network,
# no telemetry, no package downloads. Invoked by engines.js with a bounded
# timeout; Node kills the process on timeout.
#
# Modes:
#   -Probe                      print "WINRT_PROBE_OK langs=... maxdim=N" and exit 0
#   -OutDir D -Images "a|b" [-LangTag xx-YY]
#                               OCR each image and write <basename>.json to D:
#                               { width, height, lines: [{text,x,y,w,h}, ...] }
#                               then print "WINRT_OCR_DONE pages=N".
#
# stdout carries only machine markers (ASCII). Detailed error text goes to
# stderr so that no document path leaks into the caller's structured result.

param(
  [string]$OutDir,
  [string]$Images,
  [string]$LangTag,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch {
  [Console]::Error.WriteLine('winrt: type activation failed: ' + $_.Exception.Message)
  Write-Output 'WINRT_PROBE_FAIL types'
  exit 10
}

try {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
} catch {
  $asTaskGeneric = $null
}
if (-not $asTaskGeneric) {
  [Console]::Error.WriteLine('winrt: AsTask helper not found')
  Write-Output 'WINRT_PROBE_FAIL astask'
  exit 11
}

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$engine = $null
if ($LangTag) {
  try {
    $language = [Windows.Globalization.Language]::new($LangTag)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  } catch {
    [Console]::Error.WriteLine('winrt: requested language failed: ' + $_.Exception.Message)
  }
}
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
  Write-Output 'WINRT_PROBE_FAIL no-engine'
  exit 12
}

if ($Probe) {
  $tags = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ','
  $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  Write-Output ('WINRT_PROBE_OK langs=' + $tags + ' maxdim=' + $maxDim)
  exit 0
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$processed = 0

try {
  foreach ($imagePath in ($Images -split '\|')) {
    if (-not $imagePath) { continue }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $bitmap = $null
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

      $lines = New-Object System.Collections.ArrayList
      foreach ($line in $result.Lines) {
        $minX = [double]::MaxValue
        $minY = [double]::MaxValue
        $maxX = [double]::MinValue
        $maxY = [double]::MinValue
        foreach ($word in $line.Words) {
          $rect = $word.BoundingRect
          if ($rect.X -lt $minX) { $minX = $rect.X }
          if ($rect.Y -lt $minY) { $minY = $rect.Y }
          if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
          if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
        }
        if ($minX -eq [double]::MaxValue) { $minX = 0; $minY = 0; $maxX = 0; $maxY = 0 }
        [void]$lines.Add([ordered]@{
          text = [string]$line.Text
          x = [math]::Round($minX, 1)
          y = [math]::Round($minY, 1)
          w = [math]::Round($maxX - $minX, 1)
          h = [math]::Round($maxY - $minY, 1)
        })
      }

      $payload = [ordered]@{
        width = [int]$bitmap.PixelWidth
        height = [int]$bitmap.PixelHeight
        lines = @($lines)
      }
      $baseName = [System.IO.Path]::GetFileNameWithoutExtension($imagePath)
      $outPath = Join-Path $OutDir ($baseName + '.json')
      [System.IO.File]::WriteAllText($outPath, (ConvertTo-Json -InputObject $payload -Depth 4 -Compress), $utf8)
      $processed += 1
      Write-Output ('WINRT_OCR_PAGE ' + $baseName + ' lines=' + $lines.Count)
    } finally {
      if ($bitmap) { $bitmap.Dispose() }
      $stream.Dispose()
    }
  }
} catch {
  [Console]::Error.WriteLine('winrt: OCR failed: ' + $_.Exception.Message)
  Write-Output 'WINRT_OCR_FAIL ocr'
  exit 13
}

Write-Output ('WINRT_OCR_DONE pages=' + $processed)
exit 0

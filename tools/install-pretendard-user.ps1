$ErrorActionPreference = 'Stop'

$fontDirectory = 'C:\Users\mily7\AppData\Local\Microsoft\Windows\Fonts'
$fontFiles = Get-ChildItem -LiteralPath $fontDirectory -Filter 'Pretendard-*.otf' | Sort-Object Name

if ($fontFiles.Count -ne 9) {
    throw "Expected 9 Pretendard font files, found $($fontFiles.Count)."
}

$registryPath = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
New-Item -Path $registryPath -Force | Out-Null

Add-Type -AssemblyName PresentationCore
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class FontRegistration {
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int AddFontResourceEx(string fileName, uint flags, IntPtr reserved);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint message,
        IntPtr wParam,
        string lParam,
        uint flags,
        uint timeout,
        out IntPtr result
    );
}
'@

$installed = foreach ($fontFile in $fontFiles) {
    $glyph = [System.Windows.Media.GlyphTypeface]::new([Uri]$fontFile.FullName)
    $family = $glyph.Win32FamilyNames.Values | Select-Object -First 1
    $face = $glyph.Win32FaceNames.Values | Select-Object -First 1
    $registryName = if ($face -eq 'Regular') {
        "$family (OpenType)"
    } else {
        "$family $face (OpenType)"
    }

    New-ItemProperty -LiteralPath $registryPath -Name $registryName -Value $fontFile.FullName -PropertyType String -Force | Out-Null
    $loaded = [FontRegistration]::AddFontResourceEx($fontFile.FullName, 0, [IntPtr]::Zero)

    [PSCustomObject]@{
        File = $fontFile.Name
        RegistryName = $registryName
        LoadedFaces = $loaded
    }
}

$broadcastResult = [IntPtr]::Zero
[void][FontRegistration]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x001D,
    [IntPtr]::Zero,
    $null,
    0x0002,
    5000,
    [ref]$broadcastResult
)

$installed | Format-Table -AutoSize

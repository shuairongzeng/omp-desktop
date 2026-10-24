Add-Type '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' -Name U32b -Namespace W
$p = Start-Process 'D:\GitHub\omp-desktop-r7\src-tauri\target\release\omp-desktop.exe' -PassThru
Start-Sleep 8
$p.Refresh()
$h = $p.MainWindowHandle
[W.U32b]::ShowWindow($h, 0) | Out-Null
Start-Sleep 1
Write-Output ('visible-after-hide: ' + [W.U32b]::IsWindowVisible($h))
# Ctrl(0x11) down, Alt(0x12) down, Space(0x20) down/up, Alt up, Ctrl up
[W.U32b]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[W.U32b]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
[W.U32b]::keybd_event(0x20, 0, 0, [System.UIntPtr]::Zero)
[W.U32b]::keybd_event(0x20, 0, 2, [System.UIntPtr]::Zero)  # KEYEVENTF_KEYUP
[W.U32b]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
[W.U32b]::keybd_event(0x11, 0, 2, [System.UIntPtr]::Zero)
Start-Sleep 2
$p.Refresh()
Write-Output ('visible-after-hotkey: ' + [W.U32b]::IsWindowVisible($h))
Stop-Process -Id $p.Id -Force

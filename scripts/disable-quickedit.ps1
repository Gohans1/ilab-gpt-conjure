# Disable QuickEdit Mode on Windows Console without altering system registry
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr template);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr h, uint m);

public static bool Disable() {
    uint m = 0;
    IntPtr h = GetStdHandle(-10);
    if (!GetConsoleMode(h, out m)) {
        h = CreateFile("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
        if (!GetConsoleMode(h, out m)) {
            return false;
        }
    }
    // 0x0040: ENABLE_QUICK_EDIT_MODE, 0x0080: ENABLE_EXTENDED_FLAGS (Required by Microsoft to change QuickEdit)
    uint newMode = (m & ~0x0040u) | 0x0080u;
    return SetConsoleMode(h, newMode);
}
'@
try {
    Add-Type -MemberDefinition $sig -Name ConsoleFix -Namespace Win32Utils -ErrorAction SilentlyContinue
    [Win32Utils.ConsoleFix]::Disable()
} catch {}


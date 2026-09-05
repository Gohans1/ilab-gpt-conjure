# Disable QuickEdit Mode on Windows Console without altering system registry
$sig = @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
public static void Disable() {
    IntPtr h = GetStdHandle(-10);
    uint m = 0;
    if (GetConsoleMode(h, out m)) {
        SetConsoleMode(h, m & ~0x0040u);
    }
}
'@
try {
    Add-Type -MemberDefinition $sig -Name ConsoleFix -Namespace Win32Utils -ErrorAction SilentlyContinue
    [Win32Utils.ConsoleFix]::Disable()
} catch {}

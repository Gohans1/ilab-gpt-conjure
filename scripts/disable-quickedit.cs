using System;
using System.Runtime.InteropServices;

static class Program {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    const uint GENERIC_READ_WRITE = 0xC0000000;
    const uint FILE_SHARE_READ_WRITE = 3;
    const uint OPEN_EXISTING = 3;
    const uint ENABLE_QUICK_EDIT_MODE = 0x0040;
    const uint ENABLE_EXTENDED_FLAGS = 0x0080;

    static void Main() {
        // Attach to parent console if running as a GUI subsystem process
        AttachConsole(-1);

        IntPtr hIn = CreateFileW("CONIN$", GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        bool shouldClose = true;
        if (hIn == IntPtr.Zero || hIn == new IntPtr(-1)) {
            hIn = GetStdHandle(-10); // STD_INPUT_HANDLE fallback
            shouldClose = false;
        }

        if (hIn != IntPtr.Zero && hIn != new IntPtr(-1)) {
            uint mode;
            if (GetConsoleMode(hIn, out mode)) {
                uint newMode = (mode & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS;
                SetConsoleMode(hIn, newMode);
            }
            if (shouldClose) {
                CloseHandle(hIn);
            }
        }
    }
}

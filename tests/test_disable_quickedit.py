import ctypes
import os
import subprocess
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestDisableQuickEdit(unittest.TestCase):
    def test_csharp_source_exists(self):
        cs_path = os.path.join(REPO_ROOT, "scripts", "disable-quickedit.cs")
        self.assertTrue(os.path.exists(cs_path), "scripts/disable-quickedit.cs must exist")
        with open(cs_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("AttachConsole", content)
        self.assertIn("CreateFileW", content)
        self.assertIn("CharSet.Unicode", content)
        self.assertIn("ENABLE_QUICK_EDIT_MODE", content)
        self.assertIn("ENABLE_EXTENDED_FLAGS", content)
        self.assertNotIn("VK_ESCAPE", content, "Must not inject VK_ESCAPE into input buffer")

    def test_binary_exists_and_runs(self):
        exe_path = os.path.join(REPO_ROOT, "bin", "disable-quickedit.exe")
        self.assertTrue(os.path.exists(exe_path), "bin/disable-quickedit.exe must exist")
        self.assertGreater(os.path.getsize(exe_path), 1024, "binary must be non-empty PE file")

        # Verify executing it successfully sets QuickEdit to False
        k = ctypes.windll.kernel32
        m = ctypes.c_uint32()
        h = k.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)
        self.assertNotEqual(h, -1, "Must be able to open CONIN$")

        try:
            # Force enable QuickEdit first
            k.GetConsoleMode(h, ctypes.byref(m))
            k.SetConsoleMode(h, m.value | 0x0040 | 0x0080)
            k.GetConsoleMode(h, ctypes.byref(m))
            self.assertTrue(bool(m.value & 0x0040), "QuickEdit should be True prior to running helper")

            # Run helper binary
            res = subprocess.run([exe_path], capture_output=True)
            self.assertEqual(res.returncode, 0, "Helper must return exit code 0")

            # Verify QuickEdit is disabled
            k.GetConsoleMode(h, ctypes.byref(m))
            self.assertFalse(bool(m.value & 0x0040), "QuickEdit must be False after running helper")
        finally:
            k.CloseHandle(h)

    def test_start_all_bat_integration(self):
        bat_path = os.path.join(REPO_ROOT, "Start-All.bat")
        with open(bat_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        self.assertNotIn("disable-quickedit.ps1", content, "Old powershell script must be removed from Start-All.bat")
        self.assertIn("bin\\disable-quickedit.exe", content, "Start-All.bat must invoke bin\\disable-quickedit.exe")
        self.assertIn("csc.exe", content, "Start-All.bat must have csc.exe fallback compilation")

    def test_build_portable_integration(self):
        build_path = os.path.join(REPO_ROOT, "packaging", "windows", "build-portable.ps1")
        with open(build_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        self.assertIn("disable-quickedit.exe", content, "build-portable.ps1 must bundle disable-quickedit.exe")
        self.assertIn("scripts/disable-quickedit.cs", content, "build-portable.ps1 must include disable-quickedit.cs")


if __name__ == "__main__":
    unittest.main()

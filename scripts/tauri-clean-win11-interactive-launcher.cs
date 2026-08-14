using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint LogonWithProfile = 0x00000001;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNewConsole = 0x00000010;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string reserved;
        public string desktop;
        public string title;
        public int x;
        public int y;
        public int xSize;
        public int ySize;
        public int xCountChars;
        public int yCountChars;
        public int fillAttribute;
        public int flags;
        public short showWindow;
        public short reserved2;
        public IntPtr reserved2Pointer;
        public IntPtr standardInput;
        public IntPtr standardOutput;
        public IntPtr standardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr process;
        public IntPtr thread;
        public int processId;
        public int threadId;
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main()
    {
        const string statusPath = @"C:\Users\qiany\Desktop\qx-tauri-clean-interactive-launcher.status";
        const string root = @"C:\Users\qiany\qx-e2e-clean";
        const string isolatedProfile = @"C:\Users\qiany\AppData\Local\Temp\qx-clean-interactive-profile";
        IntPtr logonToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            var sessionId = WTSGetActiveConsoleSessionId();
            if (!WTSQueryUserToken(sessionId, out logonToken))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSQueryUserToken failed");
            if (!CreateEnvironmentBlock(out environment, logonToken, false))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateEnvironmentBlock failed");

            var command = new StringBuilder(string.Format(
                "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -Command \"$exitCode=1; try {{ New-Item -ItemType Directory -Force -Path '{2}' | Out-Null; $p=(Get-ChildItem -LiteralPath '{0}' -Filter '*setup.exe' | Select-Object -First 1).FullName; $env:LOCALAPPDATA='{2}'; $env:APPDATA='{2}\\Roaming'; $env:TEMP='{2}\\Temp'; $env:TMP='{2}\\Temp'; $env:QX_TAURI_CLEAN_E2E='1'; $env:QX_TAURI_NSIS=$p; & '{1}\\node.exe' --experimental-transform-types '{1}\\scripts\\tauri-clean-win11-e2e.ts' *> '{1}\\run.log'; $exitCode=$LASTEXITCODE }} finally {{ Set-Location -LiteralPath $env:WINDIR; [IO.File]::WriteAllText('{1}\\run.exit', $exitCode.ToString()); Remove-Item -LiteralPath '{2}' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '{0}' -Recurse -Force -ErrorAction SilentlyContinue; $cleanup=if ((Test-Path -LiteralPath '{2}') -or (Test-Path -LiteralPath '{0}')) {{ 'cleanup-incomplete' }} else {{ 'cleanup-complete' }}; [IO.File]::WriteAllText('{3}', ('completed exit=' + $exitCode + ' ' + $cleanup)) }}\"",
                root,
                root,
                isolatedProfile,
                statusPath));
            var startupInfo = new StartupInfo
            {
                cb = Marshal.SizeOf<StartupInfo>(),
                desktop = @"winsta0\default",
                title = "QX clean Win11 E2E",
            };
            ProcessInformation processInformation;
            if (!CreateProcessAsUser(
                    logonToken,
                    null,
                    command,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateUnicodeEnvironment | CreateNewConsole,
                    environment,
                    root,
                    ref startupInfo,
                    out processInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed");
            }

            CloseHandle(processInformation.thread);
            CloseHandle(processInformation.process);
            File.WriteAllText(statusPath, "launched interactive clean runner process " + processInformation.processId + " in session " + sessionId);
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllText(statusPath, error.ToString());
            return 1;
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (logonToken != IntPtr.Zero) CloseHandle(logonToken);
        }
    }
}

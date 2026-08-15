using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class QXFullOfflineInstaller
{
    private const long ExpectedSystemImageBytes = 3576692736L;
    private const long MinimumFreeBytes = 16L * 1024L * 1024L * 1024L;
    private static readonly byte[] SevenZipMagic = { 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C };

    private static int Main(string[] args)
    {
        string executableDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? Environment.CurrentDirectory;
        string destination = args.Length > 0 && !string.IsNullOrWhiteSpace(args[0])
            ? Path.GetFullPath(args[0])
            : Path.Combine(executableDirectory, "QXMovie");
        string workDirectory = Path.Combine(
            Path.GetDirectoryName(destination) ?? executableDirectory,
            ".qx-full-offline-" + Guid.NewGuid().ToString("N"));
        try
        {
            EnsureFreeSpace(destination);
            Directory.CreateDirectory(workDirectory);
            string sevenZipPath = Path.Combine(workDirectory, "7za.exe");
            string sevenZipDllPath = Path.Combine(workDirectory, "7z.dll");
            string sevenZipCodecPath = Path.Combine(workDirectory, "7zxa.dll");
            CopyResource("SevenZip.exe", sevenZipPath);
            CopyResource("SevenZip.dll", sevenZipDllPath);
            CopyResource("SevenZipCodec.dll", sevenZipCodecPath);

            string archivePath = Path.Combine(workDirectory, "payload.7z");
            CopyAppendedArchive(Assembly.GetExecutingAssembly().Location, archivePath);

            Directory.CreateDirectory(destination);
            RunSevenZip(sevenZipPath, archivePath, destination);

            string systemDirectory = Path.Combine(destination, "android-runtime", "sdk", "system-images", "android-35", "google_apis", "x86_64");
            RestoreSystemImage(systemDirectory);
            string application = Path.Combine(destination, "qx-yingshi.exe");
            if (!File.Exists(application)) throw new InvalidOperationException("Installed application was not found.");

            Process.Start(new ProcessStartInfo
            {
                FileName = application,
                WorkingDirectory = destination,
                UseShellExecute = true,
            });
            return 0;
        }
        catch (Exception error)
        {
            TryDelete(workDirectory);
            try { File.WriteAllText(Path.Combine(executableDirectory, "QXFullOfflineInstaller.error.log"), error.ToString()); } catch { }
            MessageBox.Show(error.Message, "QX Movie Full Offline Installer Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            TryDelete(workDirectory);
        }
    }

    private static void EnsureFreeSpace(string destination)
    {
        string root = Path.GetPathRoot(destination);
        if (string.IsNullOrWhiteSpace(root)) return;
        DriveInfo drive = new DriveInfo(root);
        if (drive.IsReady && drive.AvailableFreeSpace < MinimumFreeBytes)
        {
            throw new InvalidOperationException(
                "安装需要至少 16 GB 可用空间。当前目标磁盘 " + root + " 仅剩 " +
                (drive.AvailableFreeSpace / (1024L * 1024L * 1024L)) + " GB，请将安装包移动到空间更大的磁盘后重试，或传入其他安装目录。\n目标目录：" + destination);
        }
    }

    private static void CopyResource(string name, string destination)
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (source == null) throw new InvalidOperationException("Installer runtime resource is missing: " + name);
            using (FileStream target = File.Create(destination)) source.CopyTo(target);
        }
    }

    private static void CopyAppendedArchive(string executable, string destination)
    {
        long offset = ReadArchiveOffset(executable);
        using (FileStream input = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream output = File.Create(destination))
        {
            input.Position = offset;
            long remaining = input.Length - sizeof(long) - offset;
            byte[] buffer = new byte[1024 * 1024];
            while (remaining > 0)
            {
                int requested = (int)Math.Min(buffer.Length, remaining);
                int read = input.Read(buffer, 0, requested);
                if (read <= 0) throw new EndOfStreamException("Embedded payload is truncated.");
                output.Write(buffer, 0, read);
                remaining -= read;
            }
        }
    }

    private static long ReadArchiveOffset(string executable)
    {
        using (FileStream input = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (input.Length < sizeof(long)) throw new InvalidOperationException("Installer trailer is missing.");
            input.Position = input.Length - sizeof(long);
            byte[] trailer = new byte[sizeof(long)];
            int read = input.Read(trailer, 0, trailer.Length);
            if (read != trailer.Length) throw new EndOfStreamException("Installer trailer is truncated.");
            long offset = BitConverter.ToInt64(trailer, 0);
            if (offset <= 0 || offset >= input.Length - sizeof(long)) throw new InvalidOperationException("Installer payload offset is invalid.");
            return offset;
        }
    }

    private static long FindArchiveOffset(string executable)
    {
        using (FileStream input = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            byte[] buffer = new byte[1024 * 1024];
            long position = 0;
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int index = 0; index < read; index++)
                {
                    int current = buffer[index];
                    if (current == SevenZipMagic[0] && MatchesMagic(input, buffer, index, read, position)) return position;
                    position++;
                }
            }
        }
        throw new InvalidOperationException("Embedded payload was not found.");
    }

    private static bool MatchesMagic(FileStream input, byte[] buffer, int index, int read, long position)
    {
        for (int offset = 1; offset < SevenZipMagic.Length; offset++)
        {
            long target = position + offset;
            int value;
            if (index + offset < read) value = buffer[index + offset];
            else
            {
                long saved = input.Position;
                input.Position = target;
                value = input.ReadByte();
                input.Position = saved;
            }
            if (value != SevenZipMagic[offset]) return false;
        }
        long savedPosition = input.Position;
        input.Position = position + SevenZipMagic.Length;
        int majorVersion = input.ReadByte();
        int minorVersion = input.ReadByte();
        input.Position = savedPosition;
        return majorVersion == 0 && minorVersion == 4;
    }

    private static void RunSevenZip(string sevenZip, string archive, string destination)
    {
        Process process = Process.Start(new ProcessStartInfo
        {
            FileName = sevenZip,
            Arguments = "x \"" + archive + "\" -o\"" + destination + "\" -y",
            WorkingDirectory = Path.GetDirectoryName(sevenZip),
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        if (process == null) throw new InvalidOperationException("Could not start the bundled extractor.");
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException("Embedded payload extraction failed: " + process.ExitCode);
    }

    private static void RestoreSystemImage(string directory)
    {
        string part1 = Path.Combine(directory, "system.img.part01");
        string part2 = Path.Combine(directory, "system.img.part02");
        string image = Path.Combine(directory, "system.img");
        if (!File.Exists(part1) || !File.Exists(part2)) throw new InvalidOperationException("Android system image parts are missing.");
        using (FileStream output = File.Create(image))
        {
            using (FileStream input = File.OpenRead(part1)) input.CopyTo(output);
            using (FileStream input = File.OpenRead(part2)) input.CopyTo(output);
        }
        if (new FileInfo(image).Length != ExpectedSystemImageBytes) throw new InvalidOperationException("Android system image size check failed.");
        File.Delete(part1);
        File.Delete(part2);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, true); } catch { }
    }
}

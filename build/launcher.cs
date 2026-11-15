// Web Agent 的轻量启动器。
// 不带 Node 运行时：把程序本体嵌进 exe，启动时解到本地缓存，再用系统已装的 node 跑。
// 用 C# 5 语法编译（Windows 自带的 csc.exe），产物两百 KB 左右。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Web Agent")]
[assembly: AssemblyProduct("Web Agent")]
[assembly: AssemblyCompany("Web Agent contributors")]
[assembly: AssemblyDescription("用网页版 DeepSeek / Gemini 驱动本机编程循环")]
[assembly: AssemblyCopyright("AGPL-3.0")]
[assembly: AssemblyVersion("0.3.0.0")]
[assembly: AssemblyFileVersion("0.3.0.0")]

static class Launcher
{
    // 和 package.json 的版本保持一致；缓存目录还会拼上 payload 的哈希，
    // 所以重新打包、代码变了也会自动解到新目录，不会跑到旧缓存。
    const string Version = "0.3.0";
    const string Payload = "payload.zip";

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        byte[] payload;
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(Payload))
        {
            if (s == null) { Fail("exe 里没有找到程序数据"); return 1; }
            using (MemoryStream ms = new MemoryStream())
            {
                s.CopyTo(ms);
                payload = ms.ToArray();
            }
        }

        string hash;
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(payload);
            var sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.Append(digest[i].ToString("x2"));
            hash = sb.ToString();
        }

        string root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WebAgent", "runtime", Version + "-" + hash);
        string entry = Path.Combine(root, "web-agent.mjs");

        if (!File.Exists(entry))
        {
            try
            {
                Extract(payload, root);
            }
            catch (Exception ex)
            {
                Fail("解压程序本体失败：" + ex.Message + "\n目录：" + root);
                return 1;
            }
        }

        string node = FindNode();
        if (node == null)
        {
            Fail("没找到 Node.js。\n这个版本不捆绑运行时，需要先装 Node.js 22 或更高版本：https://nodejs.org/\n装好后重新双击 Web Agent.exe 即可。");
            return 1;
        }

        var psi = new ProcessStartInfo(node);
        psi.Arguments = Quote(entry) + (args.Length > 0 ? " " + JoinArgs(args) : "");
        psi.WorkingDirectory = Environment.CurrentDirectory;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;

        try
        {
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Fail("启动 Node 失败：" + ex.Message);
            return 1;
        }
    }

    static void Extract(byte[] payload, string root)
    {
        string tmpZip = Path.Combine(Path.GetTempPath(), "web-agent-" + Guid.NewGuid().ToString("N") + ".zip");
        string tmpDir = Path.Combine(Path.GetTempPath(), "web-agent-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllBytes(tmpZip, payload);
            ZipFile.ExtractToDirectory(tmpZip, tmpDir);

            Directory.CreateDirectory(Path.GetDirectoryName(root));
            if (Directory.Exists(root))
            {
                // 另一个实例刚好先解完了，直接用它的。
                if (File.Exists(Path.Combine(root, "web-agent.mjs"))) return;
                Directory.Delete(root, true);
            }
            try
            {
                Directory.Move(tmpDir, root);
            }
            catch
            {
                if (!File.Exists(Path.Combine(root, "web-agent.mjs"))) throw;
            }
        }
        finally
        {
            TryDelete(tmpZip);
            TryDeleteDir(tmpDir);
        }
    }

    static string FindNode()
    {
        string[] direct =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (string p in direct) if (File.Exists(p)) return p;

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            string[] parts = pathVar.Split(';');
            foreach (string dir in parts)
            {
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch { }
            }
        }
        return null;
    }

    static string JoinArgs(string[] args)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    // CreateProcess 的转义规则：反斜杠只在引号前加倍，引号用 \" 表示。
    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
        var sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in s)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                if (backslashes > 0) sb.Append('\\', backslashes);
                sb.Append(c);
            }
            backslashes = 0;
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static void TryDelete(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch { }
    }

    static void TryDeleteDir(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }

    // 打包成 winexe，双击时没有控制台：错误用弹窗说，别静默失败。
    static void Fail(string message)
    {
        Console.Error.WriteLine(message);
        try { MessageBox.Show(message, "Web Agent", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
    }
}

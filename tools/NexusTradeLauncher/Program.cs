using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

internal static class Program
{
    private const int BackendPort = 3000;
    private const int WebPort = 5173;
    private const string BackendUrl = "http://localhost:3000/";
    private const string WebUrl = "http://localhost:5173/";

    private static int Main(string[] args)
    {
        bool checkOnly = args.Length > 0 && args[0] == "--check";
        string root = FindProjectRoot(checkOnly && args.Length > 1 ? args[1] : args.Length > 0 ? args[0] : null);
        if (root == null)
        {
            Console.Error.WriteLine("NexusTrade proje klasoru bulunamadi.");
            Console.Error.WriteLine("Bu exe dosyasini nexustrade-pro-v2 klasoru icinden calistirin.");
            PauseBriefly();
            return 1;
        }

        if (checkOnly)
        {
            Console.WriteLine("OK: " + root);
            Console.WriteLine("Backend: " + (IsReady(BackendUrl, BackendPort) ? "hazir" : "kapali"));
            Console.WriteLine("Web: " + (IsReady(WebUrl, WebPort) ? "hazir" : "kapali"));
            return 0;
        }

        Console.WriteLine("NexusTrade baslatiliyor...");
        Console.WriteLine(root);

        if (!IsReady(BackendUrl, BackendPort))
        {
            StartServerWindow("NexusTrade Backend", root, BackendCommand(root));
        }
        else
        {
            Console.WriteLine("Backend zaten calisiyor: " + BackendPort);
        }

        string webRoot = Path.Combine(root, "web");
        if (!Directory.Exists(webRoot))
        {
            Console.Error.WriteLine("web klasoru bulunamadi.");
            PauseBriefly();
            return 1;
        }

        if (!IsReady(WebUrl, WebPort))
        {
            StartServerWindow("NexusTrade Web", root, WebCommand(root));
        }
        else
        {
            Console.WriteLine("Web zaten calisiyor: " + WebPort);
        }

        Console.WriteLine("Sunucular kontrol ediliyor...");
        WaitForServers(TimeSpan.FromSeconds(35));

        OpenBrowser(WebUrl);
        Console.WriteLine("Sayfa acildi: " + WebUrl);
        Console.WriteLine("Server pencerelerini kapatmadiginiz surece sistem calisir.");
        PauseBriefly();
        return 0;
    }

    private static string FindProjectRoot(string explicitRoot)
    {
        foreach (string start in CandidateRoots(explicitRoot))
        {
            DirectoryInfo current = new DirectoryInfo(start);
            while (current != null)
            {
                if (
                    File.Exists(Path.Combine(current.FullName, "package.json")) &&
                    File.Exists(Path.Combine(current.FullName, "web", "package.json")) &&
                    Directory.Exists(Path.Combine(current.FullName, "src"))
                )
                {
                    return current.FullName;
                }

                current = current.Parent;
            }
        }

        return null;
    }

    private static IEnumerable<string> CandidateRoots(string explicitRoot)
    {
        if (!string.IsNullOrWhiteSpace(explicitRoot))
        {
            yield return Path.GetFullPath(explicitRoot);
        }

        yield return Environment.CurrentDirectory;
        yield return AppDomain.CurrentDomain.BaseDirectory;
    }

    private static void StartServerWindow(string title, string workingDirectory, string command)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/d /k " + command;
        psi.WorkingDirectory = workingDirectory;
        psi.UseShellExecute = true;

        Process.Start(psi);
        Console.WriteLine(title + " penceresi acildi.");
    }

    private static string BackendCommand(string root)
    {
        return "scripts\\start-backend.cmd";
    }

    private static string WebCommand(string root)
    {
        return "scripts\\start-web.cmd";
    }

    private static void WaitForServers(TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        bool backendReady = false;
        bool webReady = false;

        while (DateTime.UtcNow < deadline)
        {
            backendReady = backendReady || IsReady(BackendUrl, BackendPort);
            webReady = webReady || IsReady(WebUrl, WebPort);

            if (backendReady && webReady)
            {
                Console.WriteLine("Backend hazir.");
                Console.WriteLine("Web hazir.");
                return;
            }

            Thread.Sleep(750);
        }

        if (!backendReady)
        {
            Console.WriteLine("Uyari: Backend hazir gorunmedi; sayfa yine de acilacak.");
        }

        if (!webReady)
        {
            Console.WriteLine("Uyari: Web hazir gorunmedi; sayfa yine de acilacak.");
        }
    }

    private static bool IsReady(string url, int port)
    {
        return IsHttpReady(url) || IsPortOpen(port);
    }

    private static bool IsHttpReady(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            request.AllowAutoRedirect = false;
            request.Proxy = null;

            HttpWebResponse response = null;
            try
            {
                response = (HttpWebResponse)request.GetResponse();
                int statusCode = (int)response.StatusCode;
                return statusCode >= 200 && statusCode < 500;
            }
            finally
            {
                if (response != null) response.Close();
            }
        }
        catch (WebException ex)
        {
            HttpWebResponse response = ex.Response as HttpWebResponse;
            if (response == null) return false;

            try
            {
                int statusCode = (int)response.StatusCode;
                return statusCode >= 200 && statusCode < 500;
            }
            finally
            {
                response.Close();
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool IsPortOpen(int port)
    {
        string[] hosts = new[] { "127.0.0.1", "::1", "localhost" };
        foreach (string host in hosts)
        {
            if (IsPortOpen(host, port)) return true;
        }

        return false;
    }

    private static bool IsPortOpen(string host, int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect(host, port, null, null);
                bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(250));
                if (!success) return false;
                client.EndConnect(result);
                return client.Connected;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void OpenBrowser(string url)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = url;
        psi.UseShellExecute = true;
        Process.Start(psi);
    }

    private static void PauseBriefly()
    {
        Thread.Sleep(2500);
    }

    private static string QuoteForCmd(string value)
    {
        return "\"" + value.Replace("\"", "\"\"") + "\"";
    }
}

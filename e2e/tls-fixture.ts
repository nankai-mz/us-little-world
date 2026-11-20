import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";

async function issueTestCertificate(dir: string): Promise<{ cert: string; key: string }> {
  const command = promisify(execFile);
  if (process.platform === "win32") {
    const { stdout } = await command("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
      $rsa = [System.Security.Cryptography.RSA]::Create(2048)
      $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $addresses = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
      $addresses.AddIpAddress([System.Net.IPAddress]::Loopback)
      $request.CertificateExtensions.Add($addresses.Build())
      $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
      @{cert=$certificate.ExportCertificatePem(); key=$rsa.ExportPkcs8PrivateKeyPem()} | ConvertTo-Json -Compress
    `]);
    return JSON.parse(stdout);
  }
  const privateKey = join(dir, "preview.key");
  const certificate = join(dir, "preview.pem");
  await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", privateKey, "-out", certificate]);
  return { cert: await readFile(certificate, "utf8"), key: await readFile(privateKey, "utf8") };
}

export async function startHttpsFixture(directory: string, upstreamPort: number) {
  const credentials = await issueTestCertificate(directory);
  const publicKey = new X509Certificate(credentials.cert).publicKey.export({ type: "spki", format: "der" });
  const certificatePin = createHash("sha256").update(publicKey).digest("base64");
  let workerUpdate = false;
  let reachable = true;
  const server = createServer(credentials, (incoming, outgoing) => {
    // Dropping the socket makes every request fail for real, including requests the
    // service worker makes on behalf of an offline page. Engine network emulation is
    // not applied to service worker sessions, so this is the only reliable offline path.
    if (!reachable) { incoming.destroy(); return; }
    const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, path: incoming.url,
      method: incoming.method, headers: incoming.headers }, (response) => {
      if (workerUpdate && incoming.url === "/sw.js" && response.statusCode === 200) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const worker = Buffer.concat(chunks).toString("utf8")
            .replace(/"cacheName":"(us-public-shell-[a-f0-9]+)"/, '"cacheName":"$1-fixture-update"');
          outgoing.writeHead(200, response.headers);
          outgoing.end(worker);
        });
        return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `https://127.0.0.1:${port}`,
    certificatePin,
    certificate: credentials.cert,
    publishWorkerUpdate: () => { workerUpdate = true; },
    setNetworkAvailable: (value: boolean) => { reachable = value; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

import { describe, expect, test } from "bun:test";
import net from "node:net";
import { buildMessage } from "./mail";
import { sendSmtp } from "./smtp";

/** Minimal SMTP server recording the commands and DATA it receives. */
const fakeServer = (auth: string) =>
  new Promise<{ port: number; commands: string[]; data: () => string; close: () => void }>((resolve) => {
    const commands: string[] = [];
    let data = "";
    const server = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 queued\r\n");
            } else {
              data += line + "\n";
            }
            continue;
          }
          commands.push(line);
          if (line.startsWith("EHLO")) socket.write(`250-fake\r\n250-${auth}\r\n250 SIZE 1000000\r\n`);
          else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
          else if (commands.at(-2) === "AUTH LOGIN") socket.write("334 UGFzc3dvcmQ6\r\n");
          else if (commands.at(-3) === "AUTH LOGIN" || line.startsWith("AUTH PLAIN")) socket.write("235 ok\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, commands, data: () => data, close: () => server.close() });
    });
  });

describe("smtp", () => {
  test("authenticates with LOGIN, sends the envelope and dot-stuffs the body", async () => {
    const server = await fakeServer("AUTH LOGIN");
    const message = buildMessage(
      { to: "to@example.com", subject: "Héllo\r\nBcc: injected@example.com", text: "line\n.\nend", html: "<p>hi</p>" },
      { address: "from@example.com", name: "Doc" },
    );
    await sendSmtp(
      { host: "127.0.0.1", port: server.port, secure: false, ignoreTls: false, username: "user", password: "pass" },
      { from: "from@example.com", to: "to@example.com", data: message.replace("Subject:", "X-Probe: .\r\n.leading\r\nSubject:") },
    );
    server.close();
    expect(server.commands.slice(1)).toEqual([
      "AUTH LOGIN",
      Buffer.from("user").toString("base64"),
      Buffer.from("pass").toString("base64"),
      "MAIL FROM:<from@example.com>",
      "RCPT TO:<to@example.com>",
      "DATA",
      "QUIT",
    ]);
    const data = server.data();
    expect(data).toContain("..leading");
    expect(data).toContain("Subject: =?UTF-8?B?");
    expect(data).not.toMatch(/^Bcc:/m);
  });

  test("uses AUTH PLAIN when offered", async () => {
    const server = await fakeServer("AUTH PLAIN LOGIN");
    await sendSmtp(
      { host: "127.0.0.1", port: server.port, secure: false, ignoreTls: true, username: "u", password: "p" },
      { from: "a@example.com", to: "b@example.com", data: "Subject: x\r\n\r\nbody" },
    );
    server.close();
    expect(server.commands[1]).toBe(`AUTH PLAIN ${Buffer.from("\0u\0p").toString("base64")}`);
  });
});

/**
 * Процесс средств ОС для секрета ключа.
 * На Windows это DPAPI текущей учётной записи, на macOS — keychain.
 * Секрет приходит в сообщении и уходит в stdin дочернего процесса, не в его командную строку.
 */
import { spawn, spawnSync } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

const meta = new Int32Array(workerData, 0, 2);
const bytes = new Uint8Array(workerData);
const service = "interview-trainer";

if (!parentPort) {
  throw new Error("os-secret-worker запущен без родителя");
}

/** Кладёт одну строку ответа туда, где её ждёт ядро. */
function reply(text) {
  const encoded = Buffer.from(text, "utf8");
  const room = bytes.length - 8;
  const body = encoded.length <= room ? encoded : Buffer.from("ERR", "utf8");
  bytes.set(body, 8);
  Atomics.store(meta, 1, body.length);
  Atomics.store(meta, 0, 1);
  Atomics.notify(meta, 0);
}

const powershellScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.Encoding]::ASCII
[Console]::OutputEncoding = [Text.Encoding]::ASCII
while ($line = [Console]::In.ReadLine()) {
  if ($line -eq 'QUIT') { break }
  $space = $line.IndexOf(' ')
  if ($space -lt 1) {
    [Console]::Out.WriteLine('ERR')
    [Console]::Out.Flush()
    continue
  }
  $op = $line.Substring(0, $space)
  $payload = $line.Substring($space + 1)
  try {
    $data = [Convert]::FromBase64String($payload)
    if ($op -eq 'SEAL') {
      $protected = [Security.Cryptography.ProtectedData]::Protect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.WriteLine('OK ' + [Convert]::ToBase64String($protected))
    } elseif ($op -eq 'OPEN') {
      $clear = [Security.Cryptography.ProtectedData]::Unprotect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.WriteLine('OK ' + [Convert]::ToBase64String($clear))
    } else {
      [Console]::Out.WriteLine('ERR')
    }
  } catch {
    [Console]::Out.WriteLine('ERR')
  }
  [Console]::Out.Flush()
}
`;

let powershell;
let pending = "";
/** @type {Array<(line: string) => void>} */
const waiters = [];

function failWaiters() {
  while (waiters.length > 0) {
    const waiter = waiters.shift();
    waiter?.("ERR");
  }
}

function onStdout(chunk) {
  pending += Buffer.from(chunk).toString("ascii");
  let nl = pending.indexOf("\n");
  while (nl >= 0) {
    const line = pending.slice(0, nl).replace(/\r$/, "");
    pending = pending.slice(nl + 1);
    const waiter = waiters.shift();
    waiter?.(line);
    nl = pending.indexOf("\n");
  }
}

function ensurePowershell() {
  if (powershell && powershell.exitCode === null && !powershell.killed) {
    return powershell;
  }
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const executable = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  powershell = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", powershellScript], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  pending = "";
  powershell.stdout.on("data", onStdout);
  powershell.on("exit", failWaiters);
  powershell.stdin.on("error", () => {});
  return powershell;
}

function askPowershell(line) {
  const child = ensurePowershell();
  return new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(`${line}\n`, (error) => {
      if (error) {
        resolve("ERR");
      }
    });
  });
}

const keychainScript = `
ObjC.import("Security");
ObjC.import("Foundation");
function run(argv) {
  var op = String(argv[0]);
  var account = String(argv[1]);
  var service = ${JSON.stringify(service)};
  var query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);
  query.setObjectForKey($(service), $.kSecAttrService);
  query.setObjectForKey($(account), $.kSecAttrAccount);
  if (op === "OPEN") {
    query.setObjectForKey($.kCFBooleanTrue, $.kSecReturnData);
    query.setObjectForKey($.kSecMatchLimitOne, $.kSecMatchLimit);
    var found = Ref();
    var status = $.SecItemCopyMatching(query, found);
    if (Number(status) !== 0) {
      console.log("ERR");
      return;
    }
    var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(found[0], $.NSUTF8StringEncoding));
    if (!text) {
      console.log("ERR");
      return;
    }
    var encoded = $.NSString.alloc.initWithUTF8String(String(text)).dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0);
    console.log("OK " + ObjC.unwrap(encoded));
    return;
  }
  var raw = $.NSString.alloc.initWithDataEncoding(
    $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile,
    $.NSUTF8StringEncoding
  );
  var secret = ObjC.unwrap(raw);
  if (!secret) {
    console.log("ERR");
    return;
  }
  $.SecItemDelete(query);
  query.setObjectForKey($(String(secret)).dataUsingEncoding($.NSUTF8StringEncoding), $.kSecValueData);
  query.setObjectForKey($.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, $.kSecAttrAccessible);
  var added = $.SecItemAdd(query, null);
  console.log(Number(added) === 0 ? "OK " : "ERR");
}
`;

/** «OK» без хвоста тоже успех: trim съедает пробел у пустого ответа keychain. */
function acceptLine(raw) {
  const line = String(raw ?? "").trim();
  if (line === "ERR") {
    return "ERR";
  }
  if (line === "OK") {
    return "OK ";
  }
  if (line.startsWith("OK ")) {
    return line;
  }
  return "ERR";
}

function askKeychain(op, payload) {
  let account = payload;
  let secret = Buffer.alloc(0);
  if (op === "SEAL") {
    const space = payload.indexOf(" ");
    if (space < 1) {
      return "ERR";
    }
    account = Buffer.from(payload.slice(0, space), "base64").toString("utf8");
    secret = Buffer.from(payload.slice(space + 1), "base64");
  }
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", keychainScript, op, account], {
    input: secret,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return "ERR";
  }
  return acceptLine(result.stdout);
}

parentPort.on("message", async (message) => {
  try {
    if (message.op === "QUIT") {
      if (powershell && powershell.exitCode === null) {
        powershell.stdin.write("QUIT\n");
        powershell.stdin.end();
      }
      reply("OK ");
      return;
    }
    const line =
      process.platform === "win32"
        ? await askPowershell(`${message.op} ${message.payload}`)
        : process.platform === "darwin"
          ? askKeychain(message.op, message.payload)
          : "ERR";
    reply(line === "ERR" || line.startsWith("OK ") ? line : "ERR");
  } catch {
    reply("ERR");
  }
});

parentPort.on("close", () => {
  if (powershell && powershell.exitCode === null) {
    powershell.kill();
  }
});

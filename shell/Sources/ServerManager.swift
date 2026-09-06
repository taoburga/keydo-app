import Foundation
import Darwin

// Owns the Node server child process. Spawn on app launch, kill on app quit.
// Polls /api/ping until the server is up (or 15s elapses).
final class ServerManager {
    enum ServerError: LocalizedError {
        case nodeNotFound([String])
        case startupTimeout(URL)
        case launchFailed(String)
        case missingServerScript(URL)
        case noAvailablePort

        var errorDescription: String? {
            switch self {
            case .nodeNotFound(let paths):
                return "Could not find a Node.js binary. Tried: \(paths.joined(separator: ", "))"
            case .startupTimeout(let url):
                return "Server didn't respond at \(url.absoluteString)/api/ping in time. See \(ServerManager.logURL.path)."
            case .launchFailed(let msg):
                return "Failed to launch Node server: \(msg)"
            case .missingServerScript(let url):
                return "server.js not found at \(url.path). Is the project layout correct?"
            case .noAvailablePort:
                return "Port 4321 is already in use. Quit the other Todo App or local server, then retry. Todo App keeps this port fixed so your saved sections, nesting and snoozes remain available."
            }
        }
    }

    private let projectRoot: URL
    private var process: Process?
    private var expectingExit = false
    // Fired (on an arbitrary thread) if the node server dies without stop()
    // being called. AppDelegate uses it to offer a restart instead of leaving
    // a dead UI behind.
    var onUnexpectedExit: (() -> Void)?
    private(set) var port: Int = 4321
    private(set) var serverURL: URL = URL(string: "http://127.0.0.1:4321")!
    private let launchToken = UUID().uuidString

    // Logs live in ~/Library/Logs (Console.app finds them; /tmp is purged by
    // macOS every few days). One previous generation is kept so a crash can
    // be diagnosed after the relaunch that used to truncate the evidence.
    static let logDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/todo-app", isDirectory: true)
    static let logURL = logDirectory.appendingPathComponent("server.log")
    static let prevLogURL = logDirectory.appendingPathComponent("server.prev.log")

    init(projectRoot: URL) {
        self.projectRoot = projectRoot
    }

    func start() async throws {
        let serverScript = projectRoot.appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: serverScript.path) else {
            throw ServerError.missingServerScript(serverScript)
        }

        let nodePath = try findNode()
        let selectedPort = 4321
        guard Self.canBind(port: selectedPort) else {
            throw ServerError.noAvailablePort
        }
        port = selectedPort
        serverURL = URL(string: "http://127.0.0.1:\(selectedPort)")!

        // Rotate the log: previous launch's log survives one generation.
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.logDirectory, withIntermediateDirectories: true)
        try? fm.removeItem(at: Self.prevLogURL)
        if fm.fileExists(atPath: Self.logURL.path) {
            try? fm.moveItem(at: Self.logURL, to: Self.prevLogURL)
        }
        fm.createFile(atPath: Self.logURL.path, contents: nil)
        let logHandle = try FileHandle(forWritingTo: Self.logURL)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [serverScript.path]
        p.currentDirectoryURL = projectRoot
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        // /api/ping echoes this random per-launch value. The readiness check
        // therefore cannot accept an unrelated service that raced onto the
        // chosen port and happened to return HTTP 200.
        env["TODO_SERVER_TOKEN"] = launchToken
        // Tells server.js it's shell-managed: it self-exits if this app dies
        // without cleaning up (force-quit), so the next launch doesn't leave
        // a stale background child behind.
        env["TODO_SHELL_MANAGED"] = "1"
        // Make sure the spawned node can find any executables it needs (e.g. swiftc for daemon rebuild).
        if env["PATH"] == nil || env["PATH"]?.isEmpty == true {
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        }
        p.environment = env
        p.standardOutput = logHandle
        p.standardError = logHandle
        p.terminationHandler = { [weak self] _ in
            guard let self = self, !self.expectingExit else { return }
            self.process = nil
            self.onUnexpectedExit?()
        }

        do {
            try p.run()
            self.process = p
        } catch {
            throw ServerError.launchFailed(error.localizedDescription)
        }

        // Poll up to 15s. (The server may rebuild the reminders-daemon at
        // startup when its source changed, which takes a few seconds.)
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if await ping() { return }
            // If the process died early, surface that. (Check `p`, not
            // self.process — the termination handler nils the latter.)
            if !p.isRunning {
                throw ServerError.launchFailed("Process exited early. See \(Self.logURL.path).")
            }
        }
        throw ServerError.startupTimeout(serverURL)
    }

    func stop() {
        expectingExit = true
        process?.terminate()
        process = nil
    }

    private func ping() async -> Bool {
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/ping"))
        req.timeoutInterval = 0.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return json["app"] as? String == "todo-app"
                && json["launchToken"] as? String == launchToken
        } catch {
            return false
        }
    }

    // Reserve-selection probe. We release the socket immediately before
    // spawning Node, so the launch token above remains the final race-proof
    // identity check.
    private static func canBind(port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        } == 0
    }

    // Try common Node install locations. Finder-launched apps inherit a minimal PATH,
    // so `which node` from a shell often won't reflect what we get here.
    private func findNode() throws -> String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? "/Users/\(NSUserName())"
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.fnm/aliases/default/bin/node",
            "\(home)/.asdf/shims/node",
        ]
        // Scan nvm
        let nvmRoot = "\(home)/.nvm/versions/node"
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot) {
            // Numeric-aware sort: plain string sort would rank v9 above v22.
            let byVersion = entries.sorted { $0.compare($1, options: .numeric) == .orderedAscending }
            for v in byVersion.reversed() {
                candidates.insert("\(nvmRoot)/\(v)/bin/node", at: 0)
            }
        }
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        throw ServerError.nodeNotFound(candidates)
    }
}

import Foundation
import Combine
import NekkoProtocol

@MainActor
final class ConnectionModel: ObservableObject {
    @Published var origin = UserDefaults.standard.string(forKey: "directHostOrigin") ?? ""
    @Published var bearer = ""
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var summaries: [SessionSummary] = []
    @Published private(set) var transcript: Session?
    @Published var error: String?
    private var client: HostClient?
    private var generation = UUID()

    func connect() async {
        guard !busy else { return }
        error = nil
        busy = true
        let operation = generation
        var candidate: HostClient?
        defer { if generation == operation { busy = false } }
        do {
            // Read saved credentials only after the user taps Connect.
            let token: String
            if bearer.isEmpty {
                guard let savedOrigin = UserDefaults.standard.string(forKey: "directHostOrigin"),
                      let savedToken = try CredentialStore.read() else { throw ConnectionError.invalidToken }
                let saved = try HostConnection(origin: savedOrigin, bearer: savedToken)
                let proposed = try HostConnection(origin: origin, bearer: savedToken)
                guard saved.origin == proposed.origin else {
                    error = "Enter a new host bearer when changing the saved host address."
                    return
                }
                token = savedToken
            } else {
                token = bearer
            }
            let connection = try HostConnection(origin: origin, bearer: token)
            let host = HostClient(connection: connection)
            candidate = host
            let list = try await host.summaries()
            guard operation == generation else { host.close(); return }
            try CredentialStore.save(token)
            UserDefaults.standard.set(connection.origin.absoluteString, forKey: "directHostOrigin")
            client?.close()
            client = host
            summaries = list
            connected = true
            bearer = ""
        } catch {
            candidate?.close()
            if operation == generation { self.error = safeMessage(error) }
        }
    }

    func refresh() async {
        guard let client, !busy else { return }
        let operation = generation
        busy = true
        error = nil
        defer { if operation == generation { busy = false } }
        do {
            let list = try await client.summaries()
            if operation == generation { summaries = list }
        } catch { if operation == generation { self.error = safeMessage(error) } }
    }

    func read(id: String) async {
        guard let client, !busy else { return }
        let operation = generation
        busy = true
        transcript = nil
        error = nil
        defer { if operation == generation { busy = false } }
        do {
            let session = try await client.read(id: id)
            guard operation == generation else { return }
            transcript = session
            if session == nil { error = "This chat no longer exists on the host." }
        } catch { if operation == generation { self.error = safeMessage(error) } }
    }

    func disconnect() {
        generation = UUID()
        client?.close()
        client = nil
        connected = false
        busy = false
        summaries = []
        transcript = nil
        bearer = ""
        error = nil
    }

    func forget() {
        disconnect()
        do {
            try CredentialStore.delete()
            UserDefaults.standard.removeObject(forKey: "directHostOrigin")
            origin = ""
        } catch { self.error = safeMessage(error) }
    }

    private func safeMessage(_ error: Error) -> String {
        if error is ConnectionError || error is CredentialStore.StoreError { return error.localizedDescription }
        // URLSession errors may contain endpoint details. Do not surface bodies or credentials.
        return "The host could not be reached securely. Check HTTPS, certificate trust, network access, and host configuration."
    }
}

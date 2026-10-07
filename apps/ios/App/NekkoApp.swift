import SwiftUI

@main
struct NekkoApp: App {
    @StateObject private var model = ConnectionModel()

    var body: some Scene {
        WindowGroup { RootView().environmentObject(model) }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: ConnectionModel

    var body: some View {
        NavigationStack {
            Group {
                if model.connected { chats } else { setup }
            }
            .navigationTitle("Nekko Native")
        }
    }

    private var setup: some View {
        Form {
            Section("Native iOS foundation") {
                Text("Read chats from a host you explicitly configure. This app does not connect automatically.")
                Text("Pairing, encrypted relay, sending, and on-device inference are not supported.")
                    .foregroundStyle(.secondary)
            }
            Section("Direct HTTPS host") {
                TextField("https://host.example.com", text: $model.origin)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Host bearer token (not a provider key)", text: $model.bearer)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Leave the token blank to use a previously saved host bearer. Connect saves it in this device’s Keychain after a successful response. The host address is saved separately.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Only use a trusted host. HTTPS protects this direct connection; it is not an end-to-end encrypted relay. Your bearer grants host access.")
                    .font(.footnote)
                Button("Connect and save host access") { Task { await model.connect() } }
                    .disabled(model.busy)
                Button("Forget saved host access", role: .destructive) { model.forget() }
                    .disabled(model.busy)
            }
            status
        }
        .disabled(model.busy)
    }

    private var chats: some View {
        List {
            Section {
                Text("Direct HTTPS · read-only snapshots")
                Text("No live updates, send, pairing, encrypted relay, or local inference. Refresh explicitly to fetch changes.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            status
            Section("Chats") {
                if model.summaries.isEmpty { Text("No visible chats on this host.").foregroundStyle(.secondary) }
                ForEach(model.summaries) { summary in
                    NavigationLink {
                        TranscriptView(id: summary.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(summary.title)
                            Text("\(summary.messageCount) messages · \(summary.updatedDate.formatted())")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(model.busy)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button("Disconnect") { model.disconnect() }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Refresh") { Task { await model.refresh() } }.disabled(model.busy)
            }
        }
    }

    @ViewBuilder private var status: some View {
        if model.busy { ProgressView("Contacting configured host…") }
        if let error = model.error { Text(error).foregroundStyle(.red).accessibilityLabel("Error: \(error)") }
    }
}

struct TranscriptView: View {
    let id: String
    @EnvironmentObject private var model: ConnectionModel

    var body: some View {
        List {
            Section {
                Text("Text snapshot only. Images, reasoning, tool inputs, and interactive approvals are not rendered. Sending is unavailable.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if model.busy { ProgressView("Reading chat…") }
            if let error = model.error { Text(error).foregroundStyle(.red) }
            if let session = model.transcript, session.id == id {
                ForEach(session.messages) { message in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.role.capitalized).font(.headline)
                        Text(message.content.isEmpty ? "(No text content)" : message.content)
                            .textSelection(.enabled)
                        if let result = message.toolResult { Text(result.output).textSelection(.enabled) }
                        if let calls = message.toolCalls, !calls.isEmpty {
                            Text("Tools: " + calls.map(\.name).joined(separator: ", ")).font(.caption)
                        }
                        if let images = message.images, !images.isEmpty {
                            Text("\(images.count) image attachment(s) not displayed").font(.caption)
                        }
                        if message.interrupted == true { Text("Interrupted reply").font(.caption).foregroundStyle(.orange) }
                        Text(message.createdDate.formatted()).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(model.transcript?.id == id ? model.transcript!.title : "Chat")
        .toolbar {
            Button("Refresh") { Task { await model.read(id: id) } }.disabled(model.busy)
        }
        .task { await model.read(id: id) }
    }
}

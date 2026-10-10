import Network
import CFNetwork

/// Monitors network path changes and updates iSH's /etc/resolv.conf
/// so DNS resolution stays current when switching between WiFi/cellular/etc.
final class NetworkMonitor {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.networkmonitor")
    private let logger = AppLogger(category: "Network")
    private var lastInterfaceTypes: Set<NWInterface.InterfaceType> = []
    private var isStarted = false

    private init() {}

    /// [B4] 现在有没有网。监视器还没启动(例如无界面的后台启动)时按"有网"处理,不让重试干等。
    var isSatisfied: Bool {
        guard isStarted else { return true }
        return monitor.currentPath.status == .satisfied
    }

    func start() {
        guard !isStarted else { return }
        isStarted = true

        // [S6] Everything below runs on `queue`, not the caller (the main
        // thread inside the launch frame): the initial resolv.conf write, the
        // CFNetwork proxy copy and the per-URL proxy probe are all blocking.
        // The immediate DNS write still happens before the first
        // NWPathMonitor callback, which is delivered on the same serial queue.
        queue.async { [self] in
            lastInterfaceTypes = activeInterfaceTypes(monitor.currentPath)
            logger.info("[Network] Monitor started — writing initial DNS config")
            ISHKernel.shared.refreshDns()
            dumpSystemProxySettings(reason: "monitor-start")
            monitor.pathUpdateHandler = { [weak self] path in
                self?.handlePathUpdate(path)
            }
            monitor.start(queue: queue)
        }
    }

    func stop() {
        guard isStarted else { return }
        monitor.cancel()
        isStarted = false
        logger.info("[Network] Monitor stopped")
    }

    private func handlePathUpdate(_ path: NWPath) {
        let currentTypes = activeInterfaceTypes(path)
        let satisfied = path.status == .satisfied

        logger.info("[Network] Path update — status: \(String(describing: path.status)), interfaces: \(currentTypes.map { String(describing: $0) })")

        let typesChanged = currentTypes != lastInterfaceTypes
        lastInterfaceTypes = currentTypes

        // Always refresh DNS on any path update — even when unsatisfied, refreshDns
        // will write the public-DNS fallback so resolv.conf is never left empty.
        if !satisfied {
            logger.info("[Network] Network unsatisfied — writing fallback DNS")
        } else if typesChanged {
            logger.info("[Network] Interface change detected — refreshing DNS")
        } else {
            logger.info("[Network] Path updated — refreshing DNS")
        }

        ISHKernel.shared.refreshDns()
        // [S8] The proxy dump (CFNetwork copy + per-URL probe + up to three
        // lines) used to run on every path tick; only an interface change can
        // change what it reports.
        if typesChanged {
            dumpSystemProxySettings(reason: "interface-change")
        }

        // Evict LLM provider connection pools ONLY when the active interface
        // set actually changed (WiFi <-> cellular, gained/lost connectivity,
        // airplane toggle). After such a transition the pooled HTTP/2
        // connections backing our long-lived streaming sessions can be dead
        // sockets; reusing one on a retry hangs until the 600s timeout. A
        // plain path tick with the SAME interfaces (signal-strength wobble,
        // route refresh) does NOT evict, so steady-state requests and
        // in-flight streams are never disturbed. Mirrors Android #740.
        if typesChanged {
            LLMSessionRegistry.shared.evictAllConnections(
                reason: satisfied ? "interface-change" : "connectivity-lost")
        }
    }

    /// Diagnostic: dump CFNetwork's view of the system proxy settings.
    /// Used to verify what (if anything) we see on 5G + VPN scenarios before
    /// deciding whether/how to inject http_proxy into the iSH shell.
    private func dumpSystemProxySettings(reason: String) {
        guard let cf = CFNetworkCopySystemProxySettings()?.takeRetainedValue(),
              let dict = cf as? [String: Any] else {
            logger.info("[Proxy] dump (\(reason)): CFNetworkCopySystemProxySettings returned nil")
            return
        }

        // Pull the keys we care about. iOS marks every CFNetworkProxies* CF
        // constant unavailable, so we use the documented string literals (same
        // values the macOS constants resolve to).
        let httpEnabled  = (dict["HTTPEnable"]   as? Int)    ?? 0
        let httpHost     =  dict["HTTPProxy"]    as? String
        let httpPort     =  dict["HTTPPort"]     as? Int
        let httpsEnabled = (dict["HTTPSEnable"]  as? Int)    ?? 0
        let httpsHost    =  dict["HTTPSProxy"]   as? String
        let httpsPort    =  dict["HTTPSPort"]    as? Int
        let socksEnabled = (dict["SOCKSEnable"]  as? Int)    ?? 0
        let socksHost    =  dict["SOCKSProxy"]   as? String
        let socksPort    =  dict["SOCKSPort"]    as? Int
        let pacEnabled   = (dict["ProxyAutoConfigEnable"]    as? Int) ?? 0
        let pacURL       =  dict["ProxyAutoConfigURLString"] as? String
        let exceptions   =  dict["ExceptionsList"]           as? [String]

        logger.info("[Proxy] dump (\(reason)) http=\(httpEnabled):\(httpHost ?? "-"):\(httpPort.map(String.init) ?? "-") https=\(httpsEnabled):\(httpsHost ?? "-"):\(httpsPort.map(String.init) ?? "-") socks=\(socksEnabled):\(socksHost ?? "-"):\(socksPort.map(String.init) ?? "-") pac=\(pacEnabled):\(pacURL ?? "-") exceptions=\(exceptions ?? [])")

        // Also dump every other key CFNetwork hands back so we don't miss
        // VPN-specific or future fields.
        let knownKeys: Set<String> = [
            "HTTPEnable", "HTTPProxy", "HTTPPort",
            "HTTPSEnable", "HTTPSProxy", "HTTPSPort",
            "SOCKSEnable", "SOCKSProxy", "SOCKSPort",
            "ProxyAutoConfigEnable", "ProxyAutoConfigURLString",
            "ExceptionsList",
        ]
        let extras = dict.filter { !knownKeys.contains($0.key) }
        if !extras.isEmpty {
            logger.info("[Proxy] dump (\(reason)) extra keys: \(extras)")
        }

        // Per-URL probe: ask CFNetwork what it would actually pick for a real
        // request. On VPN-injected / PAC scenarios this may return a proxy
        // even when the top-level dict above looks empty.
        if let probeURL = URL(string: "https://api.anthropic.com/v1/messages") {
            let arr = CFNetworkCopyProxiesForURL(probeURL as CFURL, cf).takeRetainedValue() as? [[String: Any]]
            logger.info("[Proxy] dump (\(reason)) CFNetworkCopyProxiesForURL(api.anthropic.com)=\(arr ?? [])")
        }
    }

    private func activeInterfaceTypes(_ path: NWPath) -> Set<NWInterface.InterfaceType> {
        var types = Set<NWInterface.InterfaceType>()
        for iface in path.availableInterfaces {
            types.insert(iface.type)
        }
        return types
    }
}

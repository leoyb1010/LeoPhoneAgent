import Foundation

/// Canonical, provider-agnostic tool schema shared by the runtime and pure
/// preflight tests. Keeping this type free of provider dependencies lets the
/// validation layer compile independently.
struct AgentToolDefinition {
    let name: String
    let description: String
    let parameters: [String: AgentToolParam]
    let required: [String]
    /// Explicit property generation order for providers that support it.
    let propertyOrdering: [String]?

    init(
        name: String,
        description: String,
        parameters: [String: AgentToolParam],
        required: [String],
        propertyOrdering: [String]? = nil
    ) {
        self.name = name
        self.description = description
        self.parameters = parameters
        self.required = required
        self.propertyOrdering = propertyOrdering
    }
}

struct AgentToolParam {
    let type: AgentParamType
    let description: String
    let enumValues: [String]?

    init(type: AgentParamType, description: String, enumValues: [String]? = nil) {
        self.type = type
        self.description = description
        self.enumValues = enumValues
    }
}

enum AgentParamType: String {
    case string
    case integer
    case boolean
}

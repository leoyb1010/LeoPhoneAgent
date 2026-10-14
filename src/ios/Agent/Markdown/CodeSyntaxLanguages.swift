//
//  CodeSyntaxLanguages.swift
//
//  词法高亮的语言目录：每种语言的注释/字符串写法与关键字表。
//
//  改写自 MarkdownView 的 SyntaxLanguage.swift / SyntaxLanguage+Catalog.swift：
//    https://github.com/Lakr233/MarkdownView
//    Copyright (c) 2025 Lakr Aream — MIT License（全文见 CodeSyntaxLexer.swift 头部与仓库根 THIRD_PARTY_LICENSES.md）
//
//  相对上游的改动：类型加 Leo 前缀；新增 `functions`（已知函数/命令）、`calls`（`name(` 算函数）、
//  `optionFlags`（shell 命令行选项）三项；shell 的常用命令表从「类型」改记为「函数」。
//

import Foundation

/// 扫描器需要知道的语言信息：注释与字符串怎么写、哪些词有意义。
///
/// 这是词法器的视角，不是语法分析：关键字、字面量、字符串、注释、数字着色到「读起来舒服」
/// 为止，凡是需要上下文才能判断对错的地方一律不去猜。
struct LeoSyntaxLanguage: Sendable {
    enum Mode: Sendable {
        case code
        /// HTML / XML：只着色标签、属性与注释，标签之间的文本不动。
        case markup
        /// 统一 diff：按每行首字符着色。
        case diff
    }

    var mode: Mode = .code

    var lineComments: [String] = []
    var blockComment: (open: String, close: String)?

    /// 在同一行内以同一个引号结束的字符串。
    var quotes: Set<UInt16> = [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote]
    /// 可以跨行的字符串引号。
    var multilineQuotes: Set<UInt16> = []
    /// `"""` 与 `'''` 开的字符串，以同样三个引号结束。
    var tripleQuotes = false
    /// 单引号只用于字符字面量（`'a'`、`'\n'`），所以落单的那种（Rust 的生命周期）不是字符串。
    var singleQuoteIsCharacter = false

    var keywords: Set<LeoSyntaxWord> = []
    /// `true`、`nil`、`self`：和 Xcode 一样按关键字着色。
    var literals: Set<LeoSyntaxWord> = []
    var types: Set<LeoSyntaxWord> = []
    /// 已知的函数/命令名（shell 的 `echo`、`grep` …），不必紧跟括号也算函数。
    var functions: Set<LeoSyntaxWord> = []
    /// 紧随其后的标识符是被声明的名字的关键字（函数名或类型名由关键字本身决定）。
    var declarations: Set<LeoSyntaxWord> = []
    /// 关键字不分大小写，如 SQL。
    var foldsCase = false

    /// 首字母大写的标识符是类型。
    var capitalizedTypes = true
    /// 紧跟 `(` 的标识符是函数调用（YAML / JSON 之类没有调用的语言关掉）。
    var calls = true
    /// `#include`、`#if`：`#` 加后面的词，在行首。
    var directives = false
    /// `@available`、`@dataclass`、`@media`。
    var annotations = false
    /// `$name`、`${name}`、`$1`。
    var variables = false
    /// shell 的 `-l`、`--force`。
    var optionFlags = false
    /// 词或字符串后面跟这个字符就是键。
    var keySeparator: UInt16?
    /// 键分隔符后面必须是空白或行尾才算键（YAML：`url: x` 是键，`http://x` 里的冒号不是）。
    var keyNeedsTrailingSpace = false
    /// 词里可以有连字符：`font-size`、`app-name`。
    var hyphenatedWords = false
}

extension LeoSyntaxLanguage {
    /// 围栏信息串的第一个词，小写（以空白、`{`、`,` 分隔）。
    static func name(from info: String?) -> String {
        (info ?? "")
            .split(whereSeparator: { $0.isWhitespace || $0 == "{" || $0 == "," })
            .first
            .map { $0.lowercased() } ?? ""
    }

    /// 围栏信息串指的语言；它指的是纯文本时返回 nil（保持原样不着色）。
    /// 没写语言、或目录里没有的语言，仍然套用大多数语言共有的规则。
    static func named(_ info: String?) -> LeoSyntaxLanguage? {
        let name = name(from: info)
        if let language = catalog[name] {
            return language
        }
        if plainTextNames.contains(name) {
            return nil
        }
        return .generic
    }

    private static let plainTextNames: Set<String> = [
        "text", "txt", "plain", "plaintext", "output", "log", "markdown", "md", "mermaid", "latex", "tex",
    ]
}

extension LeoSyntaxLanguage {
    /// 围栏可以用的所有名字。
    static let catalog: [String: LeoSyntaxLanguage] = {
        var catalog: [String: LeoSyntaxLanguage] = [:]
        func add(_ language: LeoSyntaxLanguage, _ names: String) {
            for name in names.split(separator: " ") {
                catalog[String(name)] = language
            }
        }
        add(.swift, "swift")
        add(.cFamily, "c h cpp c++ cc cxx hpp hh hxx objc objective-c objectivec obj-c m mm cuda metal glsl hlsl arduino ino")
        add(.csharp, "cs csharp c# fsharp f#")
        add(.java, "java")
        add(.kotlin, "kotlin kt kts")
        add(.go, "go golang")
        add(.rust, "rust rs")
        add(.javascript, "javascript js jsx mjs cjs typescript ts tsx mts cts")
        add(.python, "python py py3 python3 gyp")
        add(.ruby, "ruby rb gemfile podfile rake")
        add(.shell, "shell sh bash zsh fish ksh console terminal shell-session sh-session bat cmd powershell ps1 ps")
        add(.sql, "sql mysql postgresql postgres psql plsql sqlite tsql")
        add(.lua, "lua")
        add(.haskell, "haskell hs elm purescript")
        add(.json, "json jsonc json5 geojson webmanifest")
        add(.yaml, "yaml yml")
        add(.toml, "toml ini cfg conf properties editorconfig gitconfig")
        add(.css, "css scss sass less styl stylus")
        add(.markup, "html htm xhtml xml svg plist xsl xslt vue svelte xaml storyboard xib")
        add(.diff, "diff patch")
        add(.dockerfile, "dockerfile docker containerfile")
        add(.makefile, "makefile make mk cmake")
        add(.php, "php")
        add(.generic, "dart scala groovy gradle zig solidity sol v nim perl pl r julia jl elixir ex exs erlang erl clojure clj ocaml ml")
        return catalog
    }()

    // MARK: - Families

    static let swift = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote],
        tripleQuotes: true,
        keywords: Set(words: """
        associatedtype class deinit enum extension fileprivate func import init inout internal let open operator \
        private precedencegroup protocol public rethrows static struct subscript typealias var break case catch \
        continue default defer do else fallthrough for guard if in repeat return throw switch where while as is \
        try await async throws some any actor nonisolated isolated mutating nonmutating override final lazy weak \
        unowned convenience required dynamic indirect get set willSet didSet macro consume borrowing consuming \
        sending package
        """),
        literals: Set(words: "true false nil self Self super"),
        declarations: Set(words: "func class struct enum protocol extension actor typealias associatedtype macro"),
        directives: true,
        annotations: true
    )

    static let cFamily = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        auto break case const continue default do else enum extern for goto if inline register restrict return \
        sizeof static struct switch typedef union volatile while alignas alignof asm catch class constexpr consteval \
        constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept \
        operator private protected public reinterpret_cast static_assert static_cast dynamic_cast const_cast template \
        thread_local throw try typeid typename using virtual override final concept requires __kernel __global__ \
        __device__ __host__ kernel device constant thread
        """),
        literals: Set(words: "true false NULL nullptr nil Nil YES NO self super this"),
        types: Set(words: """
        void char short int long float double signed unsigned bool size_t ssize_t ptrdiff_t int8_t int16_t int32_t \
        int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t intptr_t wchar_t char8_t char16_t char32_t id \
        instancetype BOOL SEL IMP Class half float2 float3 float4 uint
        """),
        declarations: Set(words: "struct class enum union namespace"),
        directives: true,
        annotations: true
    )

    static let csharp = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        abstract as break case catch checked class const continue default delegate do else enum event explicit \
        extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out \
        override params private protected public readonly ref return sealed sizeof stackalloc static struct switch \
        throw try typeof unchecked unsafe using virtual volatile while async await var dynamic get set init record \
        yield where when partial let match with type module open member
        """),
        literals: Set(words: "true false null this base"),
        types: Set(words: "bool byte char decimal double float int long object sbyte short string uint ulong ushort void nint nuint"),
        declarations: Set(words: "class struct interface enum record namespace"),
        directives: true
    )

    static let java = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        tripleQuotes: true,
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        abstract assert break case catch class const continue default do else enum extends final finally for goto \
        if implements import instanceof interface native new package private protected public return static \
        strictfp switch synchronized throw throws transient try volatile while var record sealed permits yield
        """),
        literals: Set(words: "true false null this super"),
        types: Set(words: "boolean byte char double float int long short void"),
        declarations: Set(words: "class interface enum record"),
        annotations: true
    )

    static let kotlin = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        tripleQuotes: true,
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        package import class interface fun val var object companion data sealed enum annotation open abstract final \
        override private protected public internal inline suspend operator infix tailrec lateinit const if else when \
        for while do return break continue throw try catch finally in is as by where init constructor typealias get \
        set reified crossinline noinline out vararg expect actual value
        """),
        literals: Set(words: "true false null this super it"),
        declarations: Set(words: "fun class interface object typealias"),
        annotations: true
    )

    static let go = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        multilineQuotes: [LeoSyntaxUnit.backtick],
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        break case chan const continue default defer else fallthrough for func go goto if import interface map \
        package range return select struct switch type var
        """),
        literals: Set(words: "true false nil iota"),
        types: Set(words: """
        bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 \
        uint16 uint32 uint64 uintptr any
        """),
        declarations: Set(words: "func type"),
        capitalizedTypes: false
    )

    static let rust = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        singleQuoteIsCharacter: true,
        keywords: Set(words: """
        as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move \
        mut pub ref return static struct trait type unsafe use where while macro_rules union
        """),
        literals: Set(words: "true false self Self super None Some Ok Err"),
        types: Set(words: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str"),
        declarations: Set(words: "fn struct enum trait type mod union macro_rules"),
        directives: true
    )

    static let javascript = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        multilineQuotes: [LeoSyntaxUnit.backtick],
        keywords: Set(words: """
        break case catch class const continue debugger default delete do else export extends finally for function \
        if import in instanceof let new of return static switch throw try typeof var void while with yield async \
        await from as get set interface type enum implements namespace declare abstract private protected public \
        readonly keyof infer is satisfies module
        """),
        literals: Set(words: "true false null undefined this super NaN Infinity"),
        types: Set(words: "string number boolean any unknown never object symbol bigint"),
        declarations: Set(words: "function class interface type enum namespace"),
        annotations: true
    )

    static let python = LeoSyntaxLanguage(
        lineComments: ["#"],
        tripleQuotes: true,
        keywords: Set(words: """
        and as assert async await break class continue def del elif else except finally for from global if import \
        in is lambda nonlocal not or pass raise return try while with yield match case
        """),
        literals: Set(words: "True False None self cls"),
        types: Set(words: "int str float bool list dict set tuple bytes object complex frozenset"),
        declarations: Set(words: "def class"),
        annotations: true
    )

    static let ruby = LeoSyntaxLanguage(
        lineComments: ["#"],
        keywords: Set(words: """
        alias and begin break case class def defined do else elsif end ensure for if in module next not or redo \
        rescue retry return super then undef unless until when while yield require require_relative include extend \
        attr_accessor attr_reader attr_writer private public protected lambda proc
        """),
        literals: Set(words: "true false nil self"),
        declarations: Set(words: "def class module")
    )

    static let shell = LeoSyntaxLanguage(
        lineComments: ["#"],
        quotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        multilineQuotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        keywords: Set(words: """
        if then else elif fi case esac for while until do done in function select time return exit export local \
        readonly declare unset source alias break continue shift trap eval exec set
        """),
        literals: Set(words: "true false"),
        functions: Set(words: """
        echo printf cd ls cat grep sed awk curl wget git sudo mkdir rm cp mv chmod chown touch find xargs tar ssh \
        scp rsync brew apt yum npm npx yarn pnpm pip pip3 python python3 node swift xcodebuild xcrun make docker \
        kubectl test read head tail sort uniq wc diff less man open kill ps top df du ln which env ping jq tmux \
        vim nano gh pod bundle cargo go rustc gcc clang uv defaults launchctl systemctl journalctl openssl unzip
        """),
        declarations: Set(words: "function"),
        capitalizedTypes: false,
        variables: true,
        optionFlags: true
    )

    static let sql = LeoSyntaxLanguage(
        lineComments: ["--"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        keywords: Set(words: """
        select from where and or not insert into values update set delete create table drop alter add column index \
        view join inner left right outer full cross on as group by order having limit offset union all distinct \
        case when then else end is like in between exists primary key foreign references default unique check \
        constraint begin commit rollback transaction with returning if replace database schema grant revoke asc desc \
        cascade trigger procedure function returns declare explain analyze vacuum pragma using natural over \
        partition window
        """),
        literals: Set(words: "true false null"),
        types: Set(words: """
        int integer bigint smallint tinyint varchar char text boolean bool date time timestamp timestamptz float \
        double decimal numeric serial bigserial real blob json jsonb uuid
        """),
        foldsCase: true,
        capitalizedTypes: false
    )

    static let lua = LeoSyntaxLanguage(
        lineComments: ["--"],
        blockComment: ("--[[", "]]"),
        keywords: Set(words: """
        and break do else elseif end for function goto if in local not or repeat return then until while
        """),
        literals: Set(words: "true false nil self"),
        declarations: Set(words: "function"),
        capitalizedTypes: false
    )

    static let haskell = LeoSyntaxLanguage(
        lineComments: ["--"],
        blockComment: ("{-", "-}"),
        quotes: [LeoSyntaxUnit.doubleQuote],
        keywords: Set(words: """
        case class data deriving do else if import in infix infixl infixr instance let module newtype of then type \
        where qualified hiding exposing port alias
        """),
        literals: Set(words: "True False")
    )

    static let json = LeoSyntaxLanguage(
        lineComments: ["//"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote],
        literals: Set(words: "true false null"),
        capitalizedTypes: false,
        calls: false,
        keySeparator: LeoSyntaxUnit.colon
    )

    static let yaml = LeoSyntaxLanguage(
        lineComments: ["#"],
        literals: Set(words: "true false null yes no on off True False Null Yes No"),
        capitalizedTypes: false,
        calls: false,
        keySeparator: LeoSyntaxUnit.colon,
        keyNeedsTrailingSpace: true,
        hyphenatedWords: true
    )

    static let toml = LeoSyntaxLanguage(
        lineComments: ["#", ";"],
        tripleQuotes: true,
        literals: Set(words: "true false"),
        capitalizedTypes: false,
        calls: false,
        keySeparator: LeoSyntaxUnit.equals,
        hyphenatedWords: true
    )

    /// 没有 `//` 注释：SCSS 有，但普通 CSS 里有不带引号的 URL。
    static let css = LeoSyntaxLanguage(
        blockComment: ("/*", "*/"),
        literals: Set(words: "important inherit initial unset auto none transparent currentColor"),
        capitalizedTypes: false,
        annotations: true,
        keySeparator: LeoSyntaxUnit.colon,
        hyphenatedWords: true
    )

    static let markup = LeoSyntaxLanguage(mode: .markup)

    static let diff = LeoSyntaxLanguage(mode: .diff)

    static let dockerfile = LeoSyntaxLanguage(
        lineComments: ["#"],
        multilineQuotes: [],
        keywords: Set(words: """
        from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck \
        shell as maintainer
        """),
        foldsCase: true,
        capitalizedTypes: false,
        variables: true
    )

    static let makefile = LeoSyntaxLanguage(
        lineComments: ["#"],
        keywords: Set(words: """
        ifeq ifneq ifdef ifndef else endif include define endef export override unexport vpath \
        add_executable add_library project \
        set if elseif endif foreach endforeach function endfunction option message find_package
        """),
        capitalizedTypes: false,
        variables: true
    )

    static let php = LeoSyntaxLanguage(
        lineComments: ["//", "#"],
        blockComment: ("/*", "*/"),
        keywords: Set(words: """
        abstract and as break case catch class clone const continue declare default do echo else elseif empty \
        enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global \
        goto if implements include include_once instanceof insteadof interface isset list match namespace new or \
        print private protected public readonly require require_once return static switch throw trait try unset use \
        var while xor yield
        """),
        literals: Set(words: "true false null TRUE FALSE NULL this self parent"),
        declarations: Set(words: "function class interface trait enum fn"),
        variables: true
    )

    /// 目录里没有的具名语言：大多数语言共有的注释、字符串与关键字。
    static let generic = LeoSyntaxLanguage(
        lineComments: ["//", "#"],
        blockComment: ("/*", "*/"),
        quotes: [LeoSyntaxUnit.doubleQuote, LeoSyntaxUnit.singleQuote, LeoSyntaxUnit.backtick],
        keywords: Set(words: """
        if else elif elsif for foreach while do return function func def fn fun defn class struct enum interface \
        trait impl import export from let var val const public private protected static new try catch finally throw \
        switch case default break continue in is as package module use using namespace type async await yield end \
        then match when with extends implements and or not
        """),
        literals: Set(words: "true false null nil none undefined self this True False None"),
        declarations: Set(words: "function func def fn fun defn class struct enum interface trait")
    )
}

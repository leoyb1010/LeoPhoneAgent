"""Use virtual bind translation with directory placeholders in Harmony App domains."""


def apply(generated, patch):
    source = (generated / "ish/fs/fake.c").read_text()
    start = source.index("static int create_relative_symlink(")
    end = source.index("/* Recursively remove a directory tree", start)
    original = source[start:end]
    replacement = """static int create_bind_placeholder(int root_fd, const char *host_link,
                                   const char *host_path) {
    (void)host_path;
    struct stat status;
    if (fstatat(root_fd, host_link, &status, AT_SYMLINK_NOFOLLOW) == 0) {
        if (S_ISDIR(status.st_mode)) return 0;
        errno = EEXIST;
        return -1;
    }
    if (errno != ENOENT) return -1;
    // Harmony's HAP domain rejects host symlinkat. The bind table and the
    // fd-relative safety shim translate every guest access to the pinned host
    // directory. This empty placeholder only supplies the rootfs directory tree.
    return mkdirat(root_fd, host_link, 0700);
}

"""
    patch("fs/fake.c", original, replacement)
    # Both update and first-registration paths preserve existing directories.
    source = (generated / "ish/fs/fake.c").read_text()
    source = source.replace("create_relative_symlink(", "create_bind_placeholder(")
    source = source.replace("remove_tree_at(g_fakefs_mount->root_fd, host_link);",
                            "/* Native core validated the empty placeholder; preserve it. */")
    source = source.replace("UPDATE symlink:", "UPDATE virtual bind:")
    source = source.replace("NEW symlink:", "NEW virtual bind:")
    source = source.replace("symlinkat returned", "directory placeholder returned")
    source = source.replace("/* Create symlink on host: data/<linux_path> -> <host_path>\n"
                            "             * First remove any existing file/dir at the path (may be non-empty) */",
                            "/* Register a virtual bind over an empty native directory placeholder. */")
    source = source.replace("/* Remove whatever is at the path (file, symlink, or directory tree) */",
                            "/* Keep the rootfs placeholder and every existing user directory intact. */")
    source = source.replace("/* Create the symlink (relative path to avoid iOS sandbox issues) */",
                            "/* Guest I/O is redirected through the bind table and fd-relative shim. */")
    start = source.index("            /* Verify the symlink was created correctly */")
    end = source.index("            /*", start + 16)
    verify = source[start:end]
    # The next block updates top-level fakefs metadata.
    if "readlinkat" not in verify:
        raise SystemExit("Unexpected bind placeholder verification block")
    source = source[:start] + """            struct stat placeholder;
            if (fstatat(g_fakefs_mount->root_fd, host_link, &placeholder, AT_SYMLINK_NOFOLLOW) < 0 ||
                !S_ISDIR(placeholder.st_mode)) {
                g_bind_mounts[i].active = false;
                return _EIO;
            }
            fprintf(stderr, "fakefs_bind_mount: slot[%d] directory placeholder ready\\n", i);

""" + source[end:]
    (generated / "ish/fs/fake.c").write_text(source)

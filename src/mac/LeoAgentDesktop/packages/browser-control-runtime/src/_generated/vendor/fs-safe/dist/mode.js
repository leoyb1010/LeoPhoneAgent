export function formatPosixMode(mode) {
    return (mode & 0o777).toString(8).padStart(3, "0");
}

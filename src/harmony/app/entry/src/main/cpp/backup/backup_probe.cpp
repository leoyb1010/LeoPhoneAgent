// OS7 SDK-only fixture. Writes public zero-filled data only under its own /data/local/tmp directory.
#include <filemanagement/archive/oh_archive.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>
struct Progress { bool cancel; int callbacks = 0; };
OH_Archive_ProgressType report(int32_t, void *data) {
    auto progress = static_cast<Progress *>(data); ++progress->callbacks;
    return progress->cancel ? OH_ARCHIVE_PROGRESS_CANCEL : OH_ARCHIVE_PROGRESS_CONTINUE;
}
int main(int argc, char **argv) {
    const bool cancel = argc > 1 && std::string(argv[1]) == "cancel";
    const std::string root = "/data/local/tmp/leobot-archive-large-fixture";
    mkdir(root.c_str(), 0700); mkdir((root + "/blobs").c_str(), 0700); mkdir((root + "/blobs/aa").c_str(), 0700);
    const auto blob = root + "/blobs/aa/" + std::string(64, 'a');
    std::vector<char> block(1024 * 1024, 0);
    { std::ofstream file(blob, std::ios::binary | std::ios::trunc); for (int i = 0; i < 128; ++i) file.write(block.data(), block.size()); if (!file) return 1; }
    { std::ofstream file(root + "/manifest.json"); file << "{}"; }
    { std::ofstream file(root + "/files.index.jsonl"); }
    const auto destination = root + (cancel ? "/cancel.zip" : "/normal.zip");
    auto writer = OH_Archive_Writer_OpenFile(destination.c_str(), OH_ARCHIVE_OPEN_MODE_CREATE, OH_ARCHIVE_FMT_ZIP);
    if (!writer) return 2;
    Progress progress{cancel};
    const auto callback = OH_Archive_Writer_SetProgressHandlerWithData(writer, report, &progress);
    const auto method = OH_Archive_Writer_SetCompressMethod(writer, OH_ARCHIVE_NO_COMPRESSION, 0);
    const auto manifest = root + "/manifest.json", index = root + "/files.index.jsonl", blobs = root + "/blobs";
    const char *sources[] = {manifest.c_str(), index.c_str(), blobs.c_str()};
    const auto result = OH_Archive_Writer_Add(writer, sources, 3);
    const auto closed = OH_Archive_Writer_Close(writer);
    rusage usage{}; getrusage(RUSAGE_SELF, &usage);
    std::printf("ARCHIVE_NATIVE_128M cancel=%d callback=%d method=%d add=%d close=%d callbacks=%d maxrss_kib=%ld\n",
        cancel, callback, method, result, closed, progress.callbacks, usage.ru_maxrss);
    if (cancel) { std::remove(destination.c_str()); return callback || method || progress.callbacks == 0 || result == OH_ARCHIVE_OK; }
    return callback || method || result || closed || usage.ru_maxrss > 64 * 1024;
}

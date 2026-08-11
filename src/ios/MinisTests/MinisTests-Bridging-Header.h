// MinisTests deliberately excludes the iSH runtime and native offloads.
// Logic tests only need the ObjC++ Jieba bridge used by TextSegmenter.
// Keeping this header narrow makes a clean checkout testable without pulling
// the app's unpublished native submodule commit or a watchOS runtime.

#ifndef MinisTests_Bridging_Header_h
#define MinisTests_Bridging_Header_h

#import "../Shared/JiebaWrapper.h"

#endif /* MinisTests_Bridging_Header_h */

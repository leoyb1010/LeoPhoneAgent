// Keep automatic dictionary learning aligned with Typeless' edit tracker:
// start a bounded watch after insertion and reset this timeout whenever user
// edit activity is observed. The advisor runs only after the user stops editing
// for the whole window, which avoids learning IME/composition intermediates.
export const VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS = 15 * 1000;

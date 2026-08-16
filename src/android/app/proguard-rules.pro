# Tink references errorprone annotations that aren't shipped at runtime
-dontwarn com.google.errorprone.annotations.**

# WorkManager looks workers up by class name after process death.
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

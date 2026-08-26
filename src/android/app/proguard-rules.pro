# Tink references errorprone annotations that aren't shipped at runtime
-dontwarn com.google.errorprone.annotations.**

# T3: Power actor class name is the Standard isolation gate.
-keep class com.leoyuan.leophoneagent.power.txn.** { *; }
-keep class com.leoyuan.leophoneagent.power.rules.** { *; }
-keep class com.leoyuan.leophoneagent.power.ui.** { *; }

# WorkManager looks workers up by class name after process death.
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

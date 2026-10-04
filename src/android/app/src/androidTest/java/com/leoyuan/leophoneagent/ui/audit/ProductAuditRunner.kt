package com.leoyuan.leophoneagent.ui.audit

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner

/** Actual Compose UI, but deliberately no MinisApp startup, PRoot or live accounts. */
class ProductAuditRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, className: String, context: Context): Application =
        super.newApplication(cl, Application::class.java.name, context)
}

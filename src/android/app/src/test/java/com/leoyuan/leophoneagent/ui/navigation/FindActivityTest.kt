package com.leoyuan.leophoneagent.ui.navigation

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.view.ContextThemeWrapper
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class FindActivityTest {
    @Test
    fun `unwraps ContextThemeWrapper and ContextWrapper to the host Activity`() {
        val activity = Activity()
        // JVM android.jar stubs do not persist ContextWrapper.mBase; override
        // getBaseContext so the unwrap path matches a real device wrapper chain.
        val wrapped = ThemeWrap(ContextWrap(activity))
        assertSame(activity, wrapped.findActivity())
        assertSame(activity, activity.findActivity())
    }

    @Test
    fun `non-activity context returns null`() {
        assertNull(Application().findActivity())
        assertNull(ContextWrap(Application()).findActivity())
        assertNull(ThemeWrap(Application()).findActivity())
    }

    private class ContextWrap(private val inner: Context) : ContextWrapper(inner) {
        override fun getBaseContext(): Context = inner
    }

    private class ThemeWrap(private val inner: Context) : ContextThemeWrapper(inner, 0) {
        override fun getBaseContext(): Context = inner
    }
}

package com.leoyuan.leophoneagent.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.isUnspecified
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 回归测试：应用内字号滑杆（AppearanceScreen 的 0.88x–1.21x）缩放 typography 时，
 * lineHeight 必须与 fontSize 同比缩放。
 *
 * 修复前 [scale] 只做 copy(fontSize = ...)：1.21x 下 bodyLarge 的字号变成
 * 19.36sp 而行高仍是 M3 默认的 24sp，多行文本的上下伸部被行盒切掉。
 */
class MinisTypographyScaleTest {

    private val delta = 0.0001f

    @Test
    fun `scales fontSize and lineHeight together when enlarging`() {
        val scaled = TextStyle(fontSize = 16.sp, lineHeight = 24.sp).scale(1.21f)

        assertEquals(16f * 1.21f, scaled.fontSize.value, delta)
        // 本次修复的核心断言：修复前这里会是 24f。
        assertEquals(24f * 1.21f, scaled.lineHeight.value, delta)
    }

    @Test
    fun `scales fontSize and lineHeight together when shrinking`() {
        val scaled = TextStyle(fontSize = 16.sp, lineHeight = 24.sp).scale(0.88f)

        assertEquals(16f * 0.88f, scaled.fontSize.value, delta)
        assertEquals(24f * 0.88f, scaled.lineHeight.value, delta)
    }

    @Test
    fun `returns the same instance for factor one`() {
        val base = TextStyle(fontSize = 16.sp, lineHeight = 24.sp)
        assertSame(base, base.scale(1f))
    }

    @Test
    fun `unspecified lineHeight does not throw`() {
        // TextUnit.times 对 Unspecified 会走 checkArithmetic 并抛
        // IllegalArgumentException；scale 里的 isSpecified 守卫必须挡住它。
        val scaled = TextStyle(fontSize = 16.sp).scale(1.21f)

        assertEquals(16f * 1.21f, scaled.fontSize.value, delta)
        assertTrue(scaled.lineHeight.isUnspecified)
    }

    @Test
    fun `unspecified fontSize does not throw`() {
        val scaled = TextStyle(lineHeight = 24.sp).scale(1.21f)

        assertTrue(scaled.fontSize.isUnspecified)
        assertEquals(24f * 1.21f, scaled.lineHeight.value, delta)
    }
}

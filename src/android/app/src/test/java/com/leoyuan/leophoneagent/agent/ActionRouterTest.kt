package com.leoyuan.leophoneagent.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionRouterTest {
    @Test
    fun savePhotoNeedsImageAndAlbumWords() {
        val hit = ActionRouter.decide("把这张图存进相册", imageCount = 1)
        assertEquals(ActionRouter.Path.Native, hit.path)
        assertEquals(ActionRouter.Kind.SavePhoto, hit.kind)
        assertEquals("系统相册", hit.chip)

        val noImage = ActionRouter.decide("把这张图存进相册", imageCount = 0)
        assertEquals(ActionRouter.Path.Agent, noImage.path)
    }

    @Test
    fun alarmParsesTomorrowEight() {
        val hit = ActionRouter.decide("定个明早 8 点闹钟", imageCount = 0)
        assertEquals(ActionRouter.Kind.SetAlarm, hit.kind)
        assertEquals(8, hit.hour)
        assertEquals(0, hit.minute)
        assertTrue(hit.tomorrow)
        assertTrue(hit.spoken().contains("08:00"))
    }

    @Test
    fun alarmColonTime() {
        val hit = ActionRouter.decide("set alarm for 7:30", imageCount = 0)
        assertEquals(7, hit.hour)
        assertEquals(30, hit.minute)
    }

    @Test
    fun calendarNeedsExplicitVerbAndTime() {
        val hit = ActionRouter.decide("把明早 9:00 开会加到日历", imageCount = 0)
        assertEquals(ActionRouter.Kind.CreateCalendar, hit.kind)
        assertEquals(9, hit.hour)
        assertTrue(hit.tomorrow)
    }

    @Test
    fun evalBankPhrases() {
        val enPhoto = ActionRouter.decide("Save this photo to the album", imageCount = 1)
        assertEquals(ActionRouter.Path.Native, enPhoto.path)
        assertEquals(ActionRouter.Kind.SavePhoto, enPhoto.kind)

        val enCal = ActionRouter.decide("add to calendar tomorrow 10:00 standup", 0)
        assertEquals(ActionRouter.Kind.CreateCalendar, enCal.kind)
        assertEquals(10, enCal.hour)
        assertTrue(enCal.tomorrow)

        val zhCal = ActionRouter.decide("create calendar event 明天 15:00 复盘", 0)
        assertEquals(ActionRouter.Kind.CreateCalendar, zhCal.kind)
        assertEquals(15, zhCal.hour)
        assertTrue(zhCal.tomorrow)

        val dawn = ActionRouter.decide("明早 6:30 闹钟", 0)
        assertEquals(ActionRouter.Kind.SetAlarm, dawn.kind)
        assertEquals(6, dawn.hour)
        assertEquals(30, dawn.minute)
        assertTrue(dawn.tomorrow)

        val tonight = ActionRouter.decide("定个今晚 22:00 闹钟 吃药", 0)
        assertEquals(ActionRouter.Kind.SetAlarm, tonight.kind)
        assertEquals(22, tonight.hour)
        assertEquals(false, tonight.tomorrow)
    }

    @Test
    fun vagueTextStaysOnAgent() {
        assertEquals(ActionRouter.Path.Agent, ActionRouter.decide("帮我看看这张图", 1).path)
        assertEquals(ActionRouter.Path.Agent, ActionRouter.decide("设个闹钟", 0).path)
        assertNull(ActionRouter.parseTime("没有时间"))
    }

    @Test
    fun flashlightAndTodoStayNativeOffline() {
        val on = ActionRouter.decide("打开手电筒", 0)
        assertEquals(ActionRouter.Kind.ToggleFlashlight, on.kind)
        assertEquals("on", on.label)
        assertTrue(on.spoken().contains("打开"))

        val off = ActionRouter.decide("turn off flashlight", 0)
        assertEquals(ActionRouter.Kind.ToggleFlashlight, off.kind)
        assertEquals("off", off.label)

        val todo = ActionRouter.decide("记个待办 买牛奶", 0)
        assertEquals(ActionRouter.Kind.CreateTodo, todo.kind)
        assertEquals("买牛奶", todo.label)

        val enTodo = ActionRouter.decide("remind me to call mom", 0)
        assertEquals(ActionRouter.Kind.CreateTodo, enTodo.kind)
        assertEquals("call mom", enTodo.label)

        assertEquals(ActionRouter.Path.Agent, ActionRouter.decide("手电筒坏了怎么办", 0).path)
        assertEquals(ActionRouter.Path.Agent, ActionRouter.decide("帮我记一下今天的会", 0).path)
    }
}

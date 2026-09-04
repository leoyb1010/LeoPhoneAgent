package com.leoyuan.leophoneagent.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class ActionRouterTest {
    @Test fun `relative calendar phrases resolve without model guessing`() {
        val monday = LocalDate.of(2026, 9, 7)
        assertEquals(11, ActionRouter.dayOffset("9月18日", monday))
        assertEquals(4, ActionRouter.dayOffset("周五", monday))
        assertEquals(11, ActionRouter.dayOffset("下周五", monday))
        assertEquals(3, ActionRouter.dayOffset("3天后", monday))
    }
    @Test
    fun nativeReceiptNamesPathVerificationAndUndo() {
        val route = ActionRouter.Decision(
            path = ActionRouter.Path.Native,
            kind = ActionRouter.Kind.CreateCalendar,
            hour = 19,
            minute = 0,
        )
        val text = route.receipt()
        assertTrue(text.contains("路径：系统日历"))
        assertTrue(text.contains("系统已确认完成"))
        assertTrue(text.contains("可在系统日历中删除"))
    }
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
        val natural = ActionRouter.decide("提醒我后天下午3点去医院复诊", 0)
        assertEquals(ActionRouter.Kind.CreateTodo, natural.kind)
        assertEquals(ActionRouter.Path.Native, natural.path)
        assertEquals(15, natural.hour)
        assertEquals(2, natural.effectiveDayOffset)
        assertEquals("去医院复诊", natural.label)
    }

    @Test
    fun clipboardAndDeviceInfoUseStrictNativeRoutes() {
        assertEquals(
            ActionRouter.Kind.ReadClipboard,
            ActionRouter.decide("剪贴板里有什么", 0).kind,
        )
        val write = ActionRouter.decide("把发布说明复制到剪贴板", 0)
        assertEquals(ActionRouter.Kind.WriteClipboard, write.kind)
        assertEquals("发布说明", write.label)

        val english = ActionRouter.decide("copy hello world to the clipboard", 0)
        assertEquals(ActionRouter.Kind.WriteClipboard, english.kind)
        assertEquals("hello world", english.label)

        assertEquals(ActionRouter.Kind.DeviceInfo, ActionRouter.decide("这台手机是什么型号", 0).kind)
        assertEquals(ActionRouter.Path.Agent, ActionRouter.decide("怎么复制到剪贴板", 0).path)
    }

    @Test
    fun incompleteTravelRecordAsksOnceInsteadOfGuessing() {
        val result = ActionRouter.decide("帮我记录明天下午19:00要去北京的高铁，车次是，座位是", 0)
        assertEquals(ActionRouter.Path.Clarify, result.path)
        assertEquals(ActionRouter.Kind.CreateTravel, result.kind)
        assertEquals("北京", result.location)
        assertEquals(listOf("车次", "座位"), result.missingFields)
        assertTrue(result.spoken().contains("车次、座位"))
    }

    @Test
    fun completeTravelRecordCompilesToNativeCalendarAndTodo() {
        val result = ActionRouter.decide("记录明天下午19:00去北京的高铁 G1234，座位12A", 0)
        assertEquals(ActionRouter.Path.Native, result.path)
        assertEquals(ActionRouter.Kind.CreateTravel, result.kind)
        assertEquals(19, result.hour)
        assertEquals("北京", result.location)
        assertTrue(result.notes.contains("G1234"))
        assertTrue(result.notes.contains("12A"))
    }

    @Test
    fun travelDoesNotRequireOptionalTicketFieldsUnlessUserNamesThem() {
        val result = ActionRouter.decide("帮我记下明天早上8点去机场的行程", 0)
        assertEquals(ActionRouter.Path.Native, result.path)
        assertEquals(ActionRouter.Kind.CreateTravel, result.kind)
        assertEquals("机场", result.location)
        assertTrue(result.missingFields.isEmpty())
    }

    @Test
    fun calendarWithoutTimeClarifiesInsteadOfFallingThroughToModel() {
        val result = ActionRouter.decide("把明天产品评审加到日历", 0)
        assertEquals(ActionRouter.Path.Clarify, result.path)
        assertEquals(ActionRouter.Kind.CreateCalendar, result.kind)
        assertEquals(listOf("开始时间"), result.missingFields)
    }
}

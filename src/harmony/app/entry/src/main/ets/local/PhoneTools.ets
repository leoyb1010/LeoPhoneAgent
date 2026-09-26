import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { geoLocationManager } from '@kit.LocationKit';
import { http } from '@kit.NetworkKit';
import { call } from '@kit.TelephonyKit';
import { FastLocalActions } from './FastLocalActions';
import { ActionDecision } from './ActionRouter';
import { LocalDateTime, nowLine, parseReminderTime, toolArg, weatherSummary } from './LocalProtocol';

class Place {
  latitude: number = 0;
  longitude: number = 0;
  name: string = '';
}

/**
 * 给模型用的手机能力。安卓、iOS 经沙箱里的设备命令做这些;鸿蒙没有命令行,直接调系统接口。
 * 都只用公开接口,不碰受限权限(读剪贴板、读通讯录、读整个日历、读相册都不做)。
 * 第一次用到时系统会弹权限框;除此之外不另加确认步骤(和离线快捷动作一样)。
 * 每个都把失败说成一句话还给模型,不抛出去。
 */
export class PhoneTools {
  static readonly NAMES: string[] = ['device_info', 'clipboard_write', 'set_alarm', 'set_reminder', 'notify',
    'flashlight', 'open_app_link', 'dial', 'location', 'weather'];

  static async run(context: common.Context, name: string, args: string): Promise<string> {
    try {
      if (name === 'device_info') {
        return FastLocalActions.deviceSummary();
      }
      if (name === 'clipboard_write') {
        return await PhoneTools.copy(toolArg(args, 'text'));
      }
      if (name === 'set_alarm') {
        return await PhoneTools.alarm(context, toolArg(args, 'hour'), toolArg(args, 'minute'),
          toolArg(args, 'label'));
      }
      if (name === 'set_reminder') {
        return await PhoneTools.reminder(context, toolArg(args, 'time'), toolArg(args, 'title'));
      }
      if (name === 'notify') {
        const ok = await FastLocalActions.postNotice(toolArg(args, 'title') || 'LeoPhoneAgent',
          toolArg(args, 'text'));
        return ok ? '通知已发出' : '通知没发出去:可能没开这个 App 的通知权限';
      }
      if (name === 'flashlight') {
        const on = toolArg(args, 'on') !== 'false';
        const ok = await FastLocalActions.setTorch(context, on);
        return ok ? (on ? '手电筒已打开' : '手电筒已关闭') : '手电筒没打开:没有相机权限或这台设备不支持';
      }
      if (name === 'open_app_link') {
        return await PhoneTools.openExternal(context, toolArg(args, 'url'));
      }
      if (name === 'dial') {
        return await PhoneTools.dial(toolArg(args, 'number'));
      }
      if (name === 'location') {
        const place = await PhoneTools.locate(context);
        return place ? `纬度 ${place.latitude.toFixed(5)},经度 ${place.longitude.toFixed(5)}` +
          (place.name.length > 0 ? `,${place.name}` : '') : '拿不到位置:没有定位权限,或定位没开';
      }
      if (name === 'weather') {
        return await PhoneTools.weather(context, toolArg(args, 'city'));
      }
      return `没有这个工具：${name}`;
    } catch (err) {
      return `${name} 没做成:${err}`;
    }
  }

  private static async copy(text: string): Promise<string> {
    if (text.length === 0) {
      return '没有要复制的内容';
    }
    return await FastLocalActions.copyText(text) ? '已复制到剪贴板' : '没复制上,再试一次';
  }

  private static async alarm(context: common.Context, hourRaw: string, minuteRaw: string,
    label: string): Promise<string> {
    const route = new ActionDecision();
    route.hour = Number(hourRaw);
    route.minute = minuteRaw.length > 0 ? Number(minuteRaw) : 0;
    route.label = label;
    if (!Number.isInteger(route.hour) || !Number.isInteger(route.minute) || route.hour < 0 || route.hour > 23 ||
      route.minute < 0 || route.minute > 59) {
      return '时间不对:hour 0–23,minute 0–59';
    }
    const ok = await FastLocalActions.addAlarm(context, route);
    const pad = route.minute < 10 ? `0${route.minute}` : `${route.minute}`;
    return ok ? `闹钟已设好:${route.hour}:${pad}${label.length > 0 ? ' ' + label : ''}` :
      '闹钟没设上:可能没给「提醒」权限';
  }

  private static async reminder(context: common.Context, time: string, title: string): Promise<string> {
    const when: LocalDateTime | null = parseReminderTime(time, Date.now());
    if (!when) {
      return `时间读不懂或已经过去:${time}。用 YYYY-MM-DD HH:mm,例如 ${nowLine(Date.now())}`;
    }
    const ok = await FastLocalActions.addReminderAt(context, when, title.length > 0 ? title : '提醒');
    return ok ? `提醒已设好:${time.trim()} ${title}` : '提醒没设上:可能没给「提醒」权限';
  }

  private static async openExternal(context: common.Context, url: string): Promise<string> {
    const link = url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link)) {
      return '要一个完整链接,例如 https://… 或 应用的 scheme';
    }
    // 后台定时任务跑在没有界面的进程里,那里打不开别的 App。
    const ui = context as common.UIAbilityContext;
    if (typeof ui.openLink !== 'function') {
      return '现在在后台,打不开别的 App;回到前台再说一次';
    }
    await ui.openLink(link, { appLinkingOnly: false });
    return '已交给系统打开';
  }

  private static async dial(number: string): Promise<string> {
    const digits = number.replace(/[\s-]/g, '');
    if (!/^\+?[0-9*#]{2,20}$/.test(digits)) {
      return '号码不对';
    }
    // 只是打开拨号盘并填好号码,拨不拨由用户按。
    await call.makeCall(digits);
    return `已打开拨号盘:${digits}`;
  }

  private static async locate(context: common.Context): Promise<Place | null> {
    const perms: Permissions[] = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    try {
      const grant = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, perms);
      if (grant.authResults.length === 0 || grant.authResults[0] !== 0) {
        return null;
      }
      const request: geoLocationManager.SingleLocationRequest = {
        locatingPriority: geoLocationManager.LocatingPriority.PRIORITY_LOCATING_SPEED,
        locatingTimeoutMs: 10000
      };
      const loc = await geoLocationManager.getCurrentLocation(request);
      const place = new Place();
      place.latitude = loc.latitude;
      place.longitude = loc.longitude;
      try {
        const rows = await geoLocationManager.getAddressesFromLocation({
          latitude: loc.latitude,
          longitude: loc.longitude,
          maxItems: 1
        });
        if (rows.length > 0) {
          place.name = rows[0].placeName ?? '';
        }
      } catch (_err) {
        // 地名是锦上添花,拿不到就只给坐标
      }
      return place;
    } catch (_err) {
      return null;
    }
  }

  private static async weather(context: common.Context, city: string): Promise<string> {
    let place: Place | null = null;
    if (city.trim().length > 0) {
      place = await PhoneTools.geocode(city.trim());
      if (!place) {
        return `找不到这个地方:${city}`;
      }
    } else {
      place = await PhoneTools.locate(context);
      if (!place) {
        return '拿不到位置:没有定位权限,或者说一个城市名';
      }
    }
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&forecast_days=3&timezone=auto';
    const json = await PhoneTools.getJson(url);
    if (!json) {
      return '天气服务连不上,稍后再试';
    }
    return weatherSummary(json, place.name.length > 0 ? place.name : '当前位置');
  }

  private static async geocode(city: string): Promise<Place | null> {
    const json = await PhoneTools.getJson('https://geocoding-api.open-meteo.com/v1/search' +
      `?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
    const rows = json ? (json as Record<string, Object>)['results'] as Record<string, Object>[] | undefined : undefined;
    if (!rows || rows.length === 0) {
      return null;
    }
    const place = new Place();
    place.latitude = Number(rows[0]['latitude'] ?? 0);
    place.longitude = Number(rows[0]['longitude'] ?? 0);
    place.name = `${rows[0]['name'] ?? city}`;
    return place;
  }

  private static async getJson(url: string): Promise<object | null> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: { 'Accept': 'application/json' },
        connectTimeout: 8000,
        readTimeout: 12000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        return null;
      }
      return typeof resp.result === 'string' ? JSON.parse(resp.result) as object : resp.result as object;
    } catch (_err) {
      return null;
    } finally {
      req.destroy();
    }
  }
}

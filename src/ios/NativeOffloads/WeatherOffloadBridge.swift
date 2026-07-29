//
//  WeatherOffloadBridge.swift
//  MinisApp
//
//  Swift bridge for WeatherKit, called from WeatherOffload.m.
//  WeatherKit is Swift-only; this class exposes weather data as NSDictionary
//  for the ObjC handler to consume.
//

import Foundation
import WeatherKit
import CoreLocation

@objc public class WeatherOffloadBridge: NSObject {

    @objc public static func fetchWeather(
        forLatitude lat: Double,
        longitude lng: Double,
        completion: @escaping (NSDictionary?, Error?) -> Void
    ) {
        let location = CLLocation(latitude: lat, longitude: lng)
        let service = WeatherService.shared

        Task {
            do {
                let weather = try await service.weather(for: location)
                let result = NSMutableDictionary()

                // Current weather
                let current = weather.currentWeather
                result["current"] = [
                    "condition": current.condition.description,
                    "temperature_c": current.temperature.converted(to: .celsius).value,
                    "apparent_temperature_c": current.apparentTemperature.converted(to: .celsius).value,
                    "humidity": current.humidity,
                    "wind_speed_kmh": current.wind.speed.converted(to: .kilometersPerHour).value,
                    "wind_direction": current.wind.compassDirection.description,
                    "pressure_hpa": current.pressure.converted(to: .hectopascals).value,
                    "pressure_trend": current.pressureTrend.description,
                    "uv_index": current.uvIndex.value,
                    "visibility_km": current.visibility.converted(to: .kilometers).value,
                    "dew_point_c": current.dewPoint.converted(to: .celsius).value,
                    "cloud_cover": current.cloudCover,
                    "is_daylight": current.isDaylight,
                    "location": ["latitude": lat, "longitude": lng],
                ] as [String: Any]

                // Hourly forecast (next 48 hours)
                let hourlyForecasts = weather.hourlyForecast.forecast
                var hourly: [[String: Any]] = []
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "HH:mm"
                dateFormatter.timeZone = TimeZone.current

                for forecast in hourlyForecasts.prefix(48) {
                    hourly.append([
                        "hour": dateFormatter.string(from: forecast.date),
                        "date": ISO8601DateFormatter().string(from: forecast.date),
                        "condition": forecast.condition.description,
                        "temp_c": forecast.temperature.converted(to: .celsius).value,
                        "apparent_temp_c": forecast.apparentTemperature.converted(to: .celsius).value,
                        "humidity": forecast.humidity,
                        "precip_chance": forecast.precipitationChance,
                        "wind_speed_kmh": forecast.wind.speed.converted(to: .kilometersPerHour).value,
                        "uv_index": forecast.uvIndex.value,
                        "cloud_cover": forecast.cloudCover,
                        "is_daylight": forecast.isDaylight,
                    ])
                }
                result["hourly"] = hourly

                // Daily forecast (next 10 days)
                let dailyForecasts = weather.dailyForecast.forecast
                var daily: [[String: Any]] = []
                let dayFormatter = DateFormatter()
                dayFormatter.dateFormat = "yyyy-MM-dd"
                let timeFormatter = DateFormatter()
                timeFormatter.dateFormat = "HH:mm"
                timeFormatter.timeZone = TimeZone.current

                for forecast in dailyForecasts.prefix(10) {
                    var entry: [String: Any] = [
                        "date": dayFormatter.string(from: forecast.date),
                        "condition": forecast.condition.description,
                        "high_c": forecast.highTemperature.converted(to: .celsius).value,
                        "low_c": forecast.lowTemperature.converted(to: .celsius).value,
                        "precip_chance": forecast.precipitationChance,
                        "wind_speed_kmh": forecast.wind.speed.converted(to: .kilometersPerHour).value,
                        "uv_index": forecast.uvIndex.value,
                    ]
                    if let sunrise = forecast.sun.sunrise {
                        entry["sunrise"] = timeFormatter.string(from: sunrise)
                    }
                    if let sunset = forecast.sun.sunset {
                        entry["sunset"] = timeFormatter.string(from: sunset)
                    }
                    daily.append(entry)
                }
                result["daily"] = daily

                // Weather alerts
                if let alerts = weather.weatherAlerts {
                    var alertList: [[String: Any]] = []
                    for alert in alerts {
                        alertList.append([
                            "summary": alert.summary,
                            "severity": alert.severity.description,
                            "source": alert.source,
                            "region": alert.region ?? "",
                        ])
                    }
                    result["alerts"] = alertList
                } else {
                    result["alerts"] = [] as [[String: Any]]
                }

                completion(result, nil)
            } catch {
                // WeatherKit mints its JWT against the app's bundle ID; on this
                // fork the App ID may not have the WeatherKit service enabled,
                // in which case every request fails at the auth stage. Fall back
                // to the keyless Open-Meteo API (the Android side already ships
                // this data source in WeatherManager.kt) with the same dictionary
                // shape the ObjC handler consumes.
                do {
                    let fallback = try await fetchOpenMeteo(latitude: lat, longitude: lng)
                    completion(fallback, nil)
                } catch let fallbackError {
                    let message = "WeatherKit failed (\(error.localizedDescription)); "
                        + "Open-Meteo fallback also failed (\(fallbackError.localizedDescription)). "
                        + "Hint: api.open-meteo.com is hosted in Europe and can time out on some cellular networks; retry on Wi-Fi."
                    completion(nil, NSError(
                        domain: "WeatherOffloadBridge",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    ))
                }
            }
        }
    }

    // MARK: - Open-Meteo fallback (no API key required)

    private static func fetchOpenMeteo(latitude: Double, longitude: Double) async throws -> NSDictionary {
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(latitude)),
            URLQueryItem(name: "longitude", value: String(longitude)),
            URLQueryItem(name: "current", value: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,cloud_cover"),
            URLQueryItem(name: "hourly", value: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m,uv_index,cloud_cover,is_day"),
            URLQueryItem(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset"),
            URLQueryItem(name: "timezone", value: "auto"),
            URLQueryItem(name: "forecast_days", value: "10"),
            URLQueryItem(name: "wind_speed_unit", value: "kmh"),
        ]

        var request = URLRequest(url: components.url!)
        // The .m handler waits at most 30s total; leave room for the WeatherKit
        // attempt that already failed before this one started.
        request.timeoutInterval = 12

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw NSError(
                domain: "WeatherOffloadBridge",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Open-Meteo HTTP \(http.statusCode)"]
            )
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(
                domain: "WeatherOffloadBridge",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Open-Meteo returned malformed JSON"]
            )
        }

        let result = NSMutableDictionary()

        // Current conditions
        if let current = json["current"] as? [String: Any] {
            let code = (current["weather_code"] as? Int) ?? -1
            var currentDict: [String: Any] = [
                "condition": openMeteoCondition(code),
                "temperature_c": (current["temperature_2m"] as? Double) ?? 0,
                "apparent_temperature_c": (current["apparent_temperature"] as? Double) ?? 0,
                "humidity": ((current["relative_humidity_2m"] as? Double) ?? 0) / 100.0,
                "wind_speed_kmh": (current["wind_speed_10m"] as? Double) ?? 0,
                "cloud_cover": ((current["cloud_cover"] as? Double) ?? 0) / 100.0,
                "is_daylight": ((current["is_day"] as? Int) ?? 1) == 1,
                "location": ["latitude": latitude, "longitude": longitude],
                "source": "open-meteo",
            ]
            if let pressure = current["surface_pressure"] as? Double {
                currentDict["pressure_hpa"] = pressure
            }
            if let windDirection = current["wind_direction_10m"] as? Double {
                currentDict["wind_direction"] = compassDirection(windDirection)
            }
            result["current"] = currentDict
        }

        // Hourly forecast. Open-Meteo returns parallel arrays of local ISO
        // times ("2026-07-27T15:00"); slice the string instead of parsing so
        // the reported hour stays in the queried location's zone.
        if let hourlyJSON = json["hourly"] as? [String: Any],
           let times = hourlyJSON["time"] as? [String] {
            let temp = hourlyJSON["temperature_2m"] as? [Double?] ?? []
            let apparent = hourlyJSON["apparent_temperature"] as? [Double?] ?? []
            let humidity = hourlyJSON["relative_humidity_2m"] as? [Double?] ?? []
            let precip = hourlyJSON["precipitation_probability"] as? [Double?] ?? []
            let codes = hourlyJSON["weather_code"] as? [Double?] ?? []
            let wind = hourlyJSON["wind_speed_10m"] as? [Double?] ?? []
            let uv = hourlyJSON["uv_index"] as? [Double?] ?? []
            let clouds = hourlyJSON["cloud_cover"] as? [Double?] ?? []
            let isDay = hourlyJSON["is_day"] as? [Double?] ?? []

            var hourly: [[String: Any]] = []
            for (index, time) in times.prefix(48).enumerated() {
                // [T-weather-numeric-cast] All numeric columns are read as
                // [Double?]: `as? [Int?]` fails for the WHOLE array the moment
                // upstream serialises any element as 21.0 instead of 21, which
                // silently emptied the column and defaulted every hour.
                // Locals (rather than one big dictionary literal) also keep the
                // type-checker inside its time budget.
                let hourValue = Self.value(hourlyDoubles: temp, index)
                let apparentValue = Self.value(hourlyDoubles: apparent, index)
                let humidityValue = Self.value(hourlyDoubles: humidity, index)
                let precipValue = Self.value(hourlyDoubles: precip, index)
                let windValue = Self.value(hourlyDoubles: wind, index)
                let uvValue = Self.value(hourlyDoubles: uv, index)
                let cloudValue = Self.value(hourlyDoubles: clouds, index)
                let codeValue = Int(Self.value(hourlyDoubles: codes, index, fallback: -1))
                let dayValue = Self.value(hourlyDoubles: isDay, index, fallback: 1)
                var row: [String: Any] = [:]
                row["hour"] = time.count >= 16 ? String(time.suffix(5)) : time
                row["date"] = time
                row["condition"] = openMeteoCondition(codeValue)
                row["temp_c"] = hourValue
                row["apparent_temp_c"] = apparentValue
                row["humidity"] = humidityValue / 100.0
                row["precip_chance"] = precipValue / 100.0
                row["wind_speed_kmh"] = windValue
                row["uv_index"] = Int(uvValue.rounded())
                row["cloud_cover"] = cloudValue / 100.0
                row["is_daylight"] = dayValue == 1
                hourly.append(row)
            }
            result["hourly"] = hourly
        }

        // Daily forecast
        if let dailyJSON = json["daily"] as? [String: Any],
           let dates = dailyJSON["time"] as? [String] {
            let codes = dailyJSON["weather_code"] as? [Double?] ?? []
            let highs = dailyJSON["temperature_2m_max"] as? [Double?] ?? []
            let lows = dailyJSON["temperature_2m_min"] as? [Double?] ?? []
            let precip = dailyJSON["precipitation_probability_max"] as? [Double?] ?? []
            let wind = dailyJSON["wind_speed_10m_max"] as? [Double?] ?? []
            let uv = dailyJSON["uv_index_max"] as? [Double?] ?? []
            let sunrises = dailyJSON["sunrise"] as? [String?] ?? []
            let sunsets = dailyJSON["sunset"] as? [String?] ?? []

            var daily: [[String: Any]] = []
            for (index, date) in dates.prefix(10).enumerated() {
                func at<T>(_ array: [T?], _ i: Int) -> T? {
                    i < array.count ? array[i] : nil
                }
                let codeValue = Int(Self.value(hourlyDoubles: codes, index, fallback: -1))
                var entry: [String: Any] = [:]
                entry["date"] = date
                entry["condition"] = openMeteoCondition(codeValue)
                entry["high_c"] = Self.value(hourlyDoubles: highs, index)
                entry["low_c"] = Self.value(hourlyDoubles: lows, index)
                entry["precip_chance"] = Self.value(hourlyDoubles: precip, index) / 100.0
                entry["wind_speed_kmh"] = Self.value(hourlyDoubles: wind, index)
                entry["uv_index"] = Int(Self.value(hourlyDoubles: uv, index).rounded())
                if let sunrise = at(sunrises, index).flatMap({ $0 }), sunrise.count >= 16 {
                    entry["sunrise"] = String(sunrise.suffix(5))
                }
                if let sunset = at(sunsets, index).flatMap({ $0 }), sunset.count >= 16 {
                    entry["sunset"] = String(sunset.suffix(5))
                }
                daily.append(entry)
            }
            result["daily"] = daily
        }

        // Open-Meteo has no alert feed; keep the key so `apple-weather alerts`
        // returns an empty list instead of a missing-field error.
        result["alerts"] = [] as [[String: Any]]
        return result
    }

    /// WMO weather interpretation codes -> human-readable condition strings
    /// (mirrors weatherCodeToDescription in the Android WeatherOffloadHandler).
    private static func openMeteoCondition(_ code: Int) -> String {
        switch code {
        case 0: return "Clear sky"
        case 1: return "Mainly clear"
        case 2: return "Partly cloudy"
        case 3: return "Overcast"
        case 45: return "Fog"
        case 48: return "Depositing rime fog"
        case 51: return "Light drizzle"
        case 53: return "Moderate drizzle"
        case 55: return "Dense drizzle"
        case 56: return "Light freezing drizzle"
        case 57: return "Dense freezing drizzle"
        case 61: return "Slight rain"
        case 63: return "Moderate rain"
        case 65: return "Heavy rain"
        case 66: return "Light freezing rain"
        case 67: return "Heavy freezing rain"
        case 71: return "Slight snowfall"
        case 73: return "Moderate snowfall"
        case 75: return "Heavy snowfall"
        case 77: return "Snow grains"
        case 80: return "Slight rain showers"
        case 81: return "Moderate rain showers"
        case 82: return "Violent rain showers"
        case 85: return "Slight snow showers"
        case 86: return "Heavy snow showers"
        case 95: return "Thunderstorm"
        case 96: return "Thunderstorm with slight hail"
        case 99: return "Thunderstorm with heavy hail"
        default: return "Unknown"
        }
    }

    /// Bounds-checked read of an Open-Meteo numeric column. `null` entries and
    /// short arrays both fall back rather than shifting every later index.
    private static func value(hourlyDoubles array: [Double?], _ index: Int, fallback: Double = 0) -> Double {
        guard index < array.count, let v = array[index] else { return fallback }
        return v
    }

    private static func compassDirection(_ degrees: Double) -> String {
        let directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                          "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        let normalized = degrees.truncatingRemainder(dividingBy: 360)
        let positive = normalized < 0 ? normalized + 360 : normalized
        let index = Int((positive / 22.5).rounded()) % 16
        return directions[index]
    }
}

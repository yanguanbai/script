import os
import glob
import json
import csv
from datetime import datetime

# 字段名中英文映射字典
FIELD_TRANSLATIONS = {
    "bv_key": "视频BV号",
    "title": "视频标题",
    "is_expired": "是否失效",
    "last_ts": "最后播放时间",       # 调整为可读时间
    "last_progress": "最后播放进度",  # 调整为可读时长
    "watch_count": "观看次数",
    "has_reached_watch_threshold": "是否达到观看阈值",
    "snapshot_ts": "快照时间",        # 调整为可读时间
    "snapshot_pos": "快照播放位置",   # 调整为可读时长
    "snapshot_progress": "快照进度",
    "snapshot_watch_time": "快照观看时长说明",
    "file_format": "文件格式",
    "file_version": "文件版本",
    "exported_at": "导出时间"          # 调整为可读时间
}

def format_timestamp(ts):
    """将时间戳（支持秒或毫秒）转换为人类易读的日期时间格式"""
    if not ts or not isinstance(ts, (int, float)) or ts == 0:
        return ""
    try:
        # 如果时间戳看起来是毫秒级的（大于 1e12），转换成秒
        if ts > 1e11:
            ts = ts / 1000.0
        dt = datetime.fromtimestamp(ts)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts)

def format_seconds(seconds):
    """将秒数或带小数的秒转换为 MM:SS 或 HH:MM:SS 格式"""
    if seconds is None or seconds == "":
        return ""
    try:
        sec_float = float(seconds)
        total_seconds = int(sec_float)
        
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        secs = total_seconds % 60
        
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes:02d}:{secs:02d}"
    except Exception:
        return str(seconds)

def convert_bvh_json_to_csv():
    json_files = glob.glob("bvh_history_backup_*.json")
    if not json_files:
        json_files = glob.glob("*.json")
        
    if not json_files:
        print("未在当前目录下找到任何 JSON 备份文件！")
        return

    for json_file in json_files:
        print(f"正在处理文件: {json_file}")
        base_name = os.path.splitext(json_file)[0]
        csv_file = f"{base_name}_readable.csv"
        
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"读取文件 {json_file} 失败: {e}")
            continue

        # 解析顶层元数据并转换时间
        file_format = data.get("format", "")
        version = data.get("version", "")
        raw_exported_at = data.get("exportedAt", "")
        # 如果 exportedAt 是时间戳数字，尝试转换；如果是字符串则直接保留
        if isinstance(raw_exported_at, (int, float)):
            exported_at = format_timestamp(raw_exported_at)
        else:
            exported_at = raw_exported_at

        records = data.get("records", {})
        rows = []

        for bv_key, record_item in records.items():
            is_expired = record_item.get("isExpired", False)
            
            inner_data = record_item.get("data", {})
            title = inner_data.get("title", "")
            
            # 时间戳转换
            last_ts = format_timestamp(inner_data.get("lastTs", 0))
            # 播放位置/进度转换为可读的时间格式（如果里面存的是秒数）
            last_progress = format_seconds(inner_data.get("lastProgress", ""))
            
            watch_count = inner_data.get("watchCount", 0)
            has_reached_threshold = inner_data.get("hasReachedWatchThreshold", False)
            
            snapshots = inner_data.get("snapshots", [])
            
            if snapshots:
                for snap in snapshots:
                    row = {
                        "bv_key": bv_key,
                        "title": title,
                        "is_expired": "是" if is_expired else "否",
                        "last_ts": last_ts,
                        "last_progress": last_progress,
                        "watch_count": watch_count,
                        "has_reached_watch_threshold": "是" if has_reached_threshold else "否",
                        "snapshot_ts": format_timestamp(snap.get("ts", "")),
                        "snapshot_pos": format_seconds(snap.get("pos", "")),
                        "snapshot_progress": snap.get("progress", ""),
                        "snapshot_watch_time": snap.get("watchTimeStr", ""),
                        "file_format": file_format,
                        "file_version": version,
                        "exported_at": exported_at
                    }
                    rows.append(row)
            else:
                row = {
                    "bv_key": bv_key,
                    "title": title,
                    "is_expired": "是" if is_expired else "否",
                    "last_ts": last_ts,
                    "last_progress": last_progress,
                    "watch_count": watch_count,
                    "has_reached_watch_threshold": "是" if has_reached_threshold else "否",
                    "snapshot_ts": "",
                    "snapshot_pos": "",
                    "snapshot_progress": "",
                    "snapshot_watch_time": "",
                    "file_format": file_format,
                    "file_version": version,
                    "exported_at": exported_at
                }
                rows.append(row)

        english_fieldnames = [
            "bv_key", "title", "is_expired", "last_ts", "last_progress", 
            "watch_count", "has_reached_watch_threshold", 
            "snapshot_ts", "snapshot_pos", "snapshot_progress", "snapshot_watch_time",
            "file_format", "file_version", "exported_at"
        ]

        chinese_fieldnames = [FIELD_TRANSLATIONS.get(field, field) for field in english_fieldnames]

        try:
            with open(csv_file, 'w', newline='', encoding='utf-8-sig') as csv_f:
                writer = csv.DictWriter(csv_f, fieldnames=chinese_fieldnames)
                writer.writeheader()
                for row in rows:
                    translated_row = {FIELD_TRANSLATIONS.get(k, k): v for k, v in row.items()}
                    writer.writerow(translated_row)
                    
            print(f"成功转换并优化排版！已生成: {csv_file}\n")
        except Exception as e:
            print(f"写入 CSV 文件失败: {e}")

if __name__ == "__main__":
    convert_bvh_json_to_csv()
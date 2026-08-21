#!/usr/bin/env python3
"""Safety-gated CenoBots robot task wrapper.

Commands are previews unless both --execute and an exact --confirm-device value
are supplied. The low-level client additionally requires
CENOBOTS_COMMANDS_ENABLED=true before it sends any command request.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from typing import Any

try:
    from .client import CenoBotsClient, CenoBotsError, from_environment
except ImportError:  # Allow direct execution: python3 integrations/cenobots/tasks.py
    from client import CenoBotsClient, CenoBotsError, from_environment


DEVICE_OPEN_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{3,128}$')
INTENSITIES = ('LOW', 'MEDIUM', 'HIGH')
SCHEDULE_DAYS = ('Mon.', 'Tue.', 'Wed.', 'Thur.', 'Fri.', 'Sat.', 'Sun.')


@dataclass(frozen=True)
class TaskPlan:
    action: str
    device_open_id: str
    endpoint: str
    payload: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        result = {
            'provider': 'cenobots',
            'action': self.action,
            'deviceOpenId': self.device_open_id,
            'method': 'POST',
            'endpoint': self.endpoint,
        }
        if self.payload is not None:
            result['payload'] = self.payload
        return result


def validate_device_open_id(value: str) -> str:
    device_open_id = value.strip()
    if not DEVICE_OPEN_ID_PATTERN.fullmatch(device_open_id):
        raise CenoBotsError('deviceOpenId must contain only letters, numbers, underscores, or hyphens')
    return device_open_id


def build_clean_plan(
    device_open_id: str,
    map_id: int,
    map_version: str,
    *,
    clean_everywhere: bool,
    area_ids: list[str] | None = None,
    intensity: str = 'MEDIUM',
    duration: int | None = None,
    fixed_laps: int = 1,
    back_point_id: str = '',
) -> TaskPlan:
    """Build an L50-compatible SWEEP mission without contacting CenoBots."""
    device_open_id = validate_device_open_id(device_open_id)
    if map_id <= 0:
        raise CenoBotsError('mapId must be a positive integer')
    map_version = map_version.strip()
    if not map_version:
        raise CenoBotsError('mapVersion is required')
    intensity = intensity.upper()
    if intensity not in INTENSITIES:
        raise CenoBotsError(f'intensity must be one of: {", ".join(INTENSITIES)}')
    if duration is not None and not 1 <= duration <= 1440:
        raise CenoBotsError('duration must be between 1 and 1440 minutes')
    if not 1 <= fixed_laps <= 3:
        raise CenoBotsError('fixedLaps must be between 1 and 3')

    normalized_areas = list(dict.fromkeys(str(value).strip() for value in (area_ids or []) if str(value).strip()))
    if clean_everywhere and normalized_areas:
        raise CenoBotsError('areaIds cannot be combined with cleanEveryWhere=true')
    if not clean_everywhere and not normalized_areas:
        raise CenoBotsError('at least one areaId is required when cleanEveryWhere=false')

    payload: dict[str, Any] = {
        'mapId': map_id,
        'mapVersion': map_version,
        'cleanEveryWhere': clean_everywhere,
        'sweepMode': 'SWEEP',
        'subSweepMode': intensity,
        'backPointId': back_point_id,
        'deviceOpenId': device_open_id,
    }
    if normalized_areas:
        payload['areaIds'] = normalized_areas
    if duration is None:
        payload['fixedLaps'] = fixed_laps
    else:
        payload['duration'] = duration

    return TaskPlan('clean', device_open_id, '/app/openapi/v1/mission', payload)


def build_control_plan(action: str, device_open_id: str) -> TaskPlan:
    device_open_id = validate_device_open_id(device_open_id)
    paths = {
        'go-home': '/app/openapi/v1/mission/home/{device}',
        'stop': '/app/openapi/v1/mission/current/stop/{device}',
        'pause': '/app/openapi/v1/mission/current/pause/{device}',
        'continue': '/app/openapi/v1/mission/current/continue/{device}',
    }
    if action not in paths:
        raise CenoBotsError(f'Unsupported CenoBots task: {action}')
    return TaskPlan(action, device_open_id, paths[action].format(device=device_open_id))


def build_schedule_plan(
    device_open_id: str,
    map_id: int,
    map_version: str,
    start_time: str,
    repeat: list[str],
    *,
    clean_everywhere: bool,
    area_ids: list[str] | None = None,
    intensity: str = 'MEDIUM',
    duration: int | None = None,
    fixed_laps: int = 1,
    back_point_id: str = '',
) -> TaskPlan:
    """Build a recurring SWEEP schedule using the same validation as a mission."""
    mission = build_clean_plan(
        device_open_id,
        map_id,
        map_version,
        clean_everywhere=clean_everywhere,
        area_ids=area_ids,
        intensity=intensity,
        duration=duration,
        fixed_laps=fixed_laps,
        back_point_id=back_point_id,
    )
    normalized_time = start_time.strip().upper()
    if not re.fullmatch(r'(0?[1-9]|1[0-2]):[0-5][0-9] (AM|PM)', normalized_time):
        raise CenoBotsError('startTime must use 12-hour format, for example 04:52 PM')
    days = list(dict.fromkeys(day.strip() for day in repeat if day.strip()))
    if not days or any(day not in SCHEDULE_DAYS for day in days):
        raise CenoBotsError('repeat must contain valid CenoBots day values such as Mon. or Fri.')
    payload = dict(mission.payload or {})
    payload.update({'startTime': normalized_time, 'repeat': days})
    return TaskPlan('schedule', mission.device_open_id, '/app/openapi/v1/schedule', payload)


def run_plan(
    plan: TaskPlan,
    *,
    execute: bool = False,
    confirm_device: str = '',
    client: CenoBotsClient | None = None,
) -> dict[str, Any]:
    if not execute:
        return {
            'ok': True,
            'dryRun': True,
            'message': 'Preview only. No API request was sent and the robot was not controlled.',
            'task': plan.as_dict(),
        }
    if confirm_device != plan.device_open_id:
        raise CenoBotsError(
            f'Live execution requires --confirm-device {plan.device_open_id} exactly'
        )

    command_client = client or from_environment()
    if plan.action == 'clean':
        response = command_client.create_temporary_mission(plan.payload or {})
    elif plan.action == 'schedule':
        response = command_client.create_schedule(plan.payload or {})
    elif plan.action == 'go-home':
        response = command_client.go_home(plan.device_open_id)
    elif plan.action == 'stop':
        response = command_client.stop_current_mission(plan.device_open_id)
    elif plan.action == 'pause':
        response = command_client.pause_current_mission(plan.device_open_id)
    elif plan.action == 'continue':
        response = command_client.continue_current_mission(plan.device_open_id)
    else:  # TaskPlan is public, so retain a defensive check here.
        raise CenoBotsError(f'Unsupported CenoBots task: {plan.action}')

    data = command_client.response_data(response, plan.action)
    return {
        'ok': True,
        'dryRun': False,
        'message': 'CenoBots accepted the command.',
        'task': plan.as_dict(),
        'result': {'data': data, 'rid': response.get('rid', '')},
    }


def add_execution_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--device-open-id', required=True, help='Target robot deviceOpenId')
    parser.add_argument('--execute', action='store_true', help='Send the command instead of showing a preview')
    parser.add_argument(
        '--confirm-device',
        default='',
        help='Required for execution; must exactly match --device-open-id',
    )


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Preview or safely execute CenoBots robot tasks')
    commands = parser.add_subparsers(dest='action', required=True)

    clean = commands.add_parser('clean', help='Create an L50 SWEEP cleaning mission')
    add_execution_arguments(clean)
    clean.add_argument('--map-id', required=True, type=int)
    clean.add_argument('--map-version', required=True)
    scope = clean.add_mutually_exclusive_group(required=True)
    scope.add_argument('--everywhere', action='store_true', help='Clean the entire mapped place')
    scope.add_argument('--area-id', action='append', help='Clean this area ID; repeat for more areas')
    clean.add_argument('--intensity', choices=INTENSITIES, default='MEDIUM')
    timing = clean.add_mutually_exclusive_group()
    timing.add_argument('--duration', type=int, help='Time limit in minutes (1-1440)')
    timing.add_argument('--fixed-laps', type=int, default=1, help='Number of laps (1-3)')
    return_target = clean.add_mutually_exclusive_group()
    return_target.add_argument('--stop-after', action='store_true', help='Stop at the end instead of returning to station')
    return_target.add_argument('--back-point-id', default='', help='Return to a custom CenoBots back-point ID')

    schedule = commands.add_parser('schedule', help='Create a recurring L-series SWEEP schedule')
    add_execution_arguments(schedule)
    schedule.add_argument('--map-id', required=True, type=int)
    schedule.add_argument('--map-version', required=True)
    schedule_scope = schedule.add_mutually_exclusive_group(required=True)
    schedule_scope.add_argument('--everywhere', action='store_true')
    schedule_scope.add_argument('--area-id', action='append')
    schedule.add_argument('--intensity', choices=INTENSITIES, default='MEDIUM')
    schedule_timing = schedule.add_mutually_exclusive_group()
    schedule_timing.add_argument('--duration', type=int)
    schedule_timing.add_argument('--fixed-laps', type=int, default=1)
    schedule.add_argument('--start-time', required=True)
    schedule.add_argument('--repeat', action='append', required=True, choices=SCHEDULE_DAYS)
    schedule.add_argument('--back-point-id', default='')

    for action, help_text in (
        ('go-home', 'Send the robot back to its charging station'),
        ('pause', 'Pause the current mission'),
        ('continue', 'Continue the paused mission'),
        ('stop', 'Stop the current mission'),
    ):
        command = commands.add_parser(action, help=help_text)
        add_execution_arguments(command)
    return parser


def plan_from_args(args: argparse.Namespace) -> TaskPlan:
    if args.action == 'clean':
        return build_clean_plan(
            args.device_open_id,
            args.map_id,
            args.map_version,
            clean_everywhere=args.everywhere,
            area_ids=args.area_id,
            intensity=args.intensity,
            duration=args.duration,
            fixed_laps=args.fixed_laps,
            back_point_id='-1' if args.stop_after else args.back_point_id,
        )
    if args.action == 'schedule':
        return build_schedule_plan(
            args.device_open_id,
            args.map_id,
            args.map_version,
            args.start_time,
            args.repeat,
            clean_everywhere=args.everywhere,
            area_ids=args.area_id,
            intensity=args.intensity,
            duration=args.duration,
            fixed_laps=args.fixed_laps,
            back_point_id=args.back_point_id,
        )
    return build_control_plan(args.action, args.device_open_id)


def main() -> int:
    args = create_parser().parse_args()
    try:
        result = run_plan(
            plan_from_args(args),
            execute=args.execute,
            confirm_device=args.confirm_device,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except CenoBotsError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, indent=2))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

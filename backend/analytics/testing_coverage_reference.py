from __future__ import annotations


CHINA_SPECIFIC_AIDAS: tuple[str, ...] = (
    "Use App Store China  [01.04.01.06.07]",
    "Traffic Info ASIA [01.04.03.01.02.07]",
    "Use Third Party App Store [01.04.01.05.03.02]",
    "Route planning and management 2.0 [01.04.02.01.01.05.24]",
    "Provide NetEase Cloud Music [01.04.01.06.04.03]",
    "Provide Festival Mode [01.04.02.01.04.08]",
    "Provide 3rd Party Gaming App [01.04.01.02.03.05]",
    "Positioning ASIA [01.04.03.01.02.01.02]",
    "Navigation Destination Input ASIA [01.04.03.01.02.03]",
    "POI Functions ASIA [01.04.03.01.02.05]",
    "Parking Finder China [01.04.03.01.05.02]",
    "Itinerary (Mobile App) [01.04.03.01.01.07.09]",
    "Use Speech operation [01.04.02.01.01.05]",
    "Connected Music China [01.04.01.06.04]",
    "Play audio via Online Services (Connected Music) [01.04.01.01.02]",
    "Voice Interface [01.04.02.01.01.02]",
    "Display map ASIA [01.04.03.01.02.04]",
    "Festival Mode [01.04.02.01.02.01.04]",
    "QQ Music [01.04.01.06.04.02]",
    "Smart Access / Digital Key (Plus) [01.03.03.03.04]",
    "Tencent MiniProgramPlatform (Tencent MPP) [01.04.01.06.01]",
    "Guiding [01.04.03.01.03.02.03]",
    "Guiding 2.0 [01.04.02.01.03.03.07.07]",
    "Guiding ASIA [01.04.03.01.02.08]",
    "Map [01.04.03.01.03.02.01]",
    "Map and Navigation Data update ASIA [01.04.03.01.02.02]",
    "Tencent MPP - MainMenu [01.04.01.06.01.01]",
    "Tencent WeChat [01.04.01.06.02]",
    "Video streaming China [01.04.01.06.05]",
    "WeChat Messaging [01.04.01.06.02.03]",
    "WeChat VoiP Call [01.04.01.06.02.02]",
    "Ximalaya [01.04.01.06.04.01]",
    "Provide Navigation 2.0 [01.04.03.01.03.06]",
    "Digital Keyring [01.04.01.06.06]",
    "PaDi - Pre-installed China VoD app (iQiyi) [01.04.04.01.05.06]",
    "Component Test -> Downstream",
    "Display weather [01.04.01.05.01.03]",
    "Intelligent Reminder  [01.04.02.01.02.02.01]",
    "Enable Registration, Login, Mapping",
    "IPA Visualization",
    "Provide IPA interactive Elements China",
    "provide HUAWEI HiCar",
    "Provide Karaoke Service",
    "Provisioning International Speller",
    "Provide App Center China",
    "Telephony via customer device",
    "Provide 3rd party gaming enablement",
    "Provide Child Seat App Provisioning International Speller [01.04.02.03.01.01.06]",
    "Telephony via customer device [01.04.01.04.01.01]",
    "Provide Launcher  [01.04.02.03.01.01.09]",
    "BT Child Seat App connection [01.06.02.04.04.04]",
    "My Modes [01.04.02.01.04.03]",
    "Use Co-Driver Entertainment",
    "Use Rear Seat Entertainment",
    "Component Test",
)


def build_feature_region_sql_expr(
    feature_area_expr: str,
    *,
    market_expr: str,
    solution_cluster_expr: str,
) -> str:
    quoted_aidas = ", ".join(
        "'{}'".format(value.replace("'", "''"))
        for value in CHINA_SPECIFIC_AIDAS
    )
    return """
        CASE
            WHEN LOWER(TRIM({market_expr})) IN ('cn', 'china', 'china specific')
                THEN 'China Specific'
            WHEN LOWER(TRIM({solution_cluster_expr})) LIKE '%china%'
                THEN 'China Specific'
            WHEN TRIM({feature_area_expr}) IN ({quoted_aidas})
                THEN 'China Specific'
            ELSE 'Global'
        END
    """.format(
        market_expr=market_expr,
        solution_cluster_expr=solution_cluster_expr,
        feature_area_expr=feature_area_expr,
        quoted_aidas=quoted_aidas,
    )


def build_tpmdashboard_project_sql_expr(
    *,
    name_expr: str,
    target_ecu_conf_expr: str,
    top_aida_expr: str,
    fallback_project_expr: str,
) -> str:
    return """
        CASE
            WHEN LOWER(TRIM({name_expr})) LIKE '%dtsv_china-rsu%'
                OR LOWER(TRIM({name_expr})) LIKE '%rsu%'
                OR LOWER(TRIM({top_aida_expr})) LIKE '%[sys_rsu]%'
                THEN 'RSU'
            WHEN LOWER(TRIM({target_ecu_conf_expr})) LIKE '%my bmw%'
                OR LOWER(TRIM({name_expr})) LIKE '%ios%'
                OR LOWER(TRIM({name_expr})) LIKE '%android%'
                OR LOWER(TRIM({name_expr})) LIKE '%harmonyos%'
                THEN 'App'
            WHEN LOWER(TRIM({target_ecu_conf_expr})) LIKE '%idcevo%'
                OR LOWER(TRIM({name_expr})) LIKE '%idcevo%'
                THEN 'IDCEVO'
            WHEN LOWER(TRIM({target_ecu_conf_expr})) LIKE '%hu-mgu_02_a%'
                OR LOWER(TRIM({name_expr})) LIKE '%hu-mgu_02_a%'
                OR LOWER(TRIM({name_expr})) LIKE '%idc23%'
                THEN 'IDC'
            WHEN LOWER(TRIM({target_ecu_conf_expr})) LIKE '%hu-mgu_02_l%'
                OR LOWER(TRIM({target_ecu_conf_expr})) LIKE '%hu-mgu_01%'
                OR LOWER(TRIM({name_expr})) LIKE '%mgu22%'
                OR LOWER(TRIM({name_expr})) LIKE '%mgu21%'
                OR LOWER(TRIM({name_expr})) LIKE '%mgu18%'
                OR LOWER(TRIM({name_expr})) LIKE '%hu-mgu_02_l%'
                OR LOWER(TRIM({name_expr})) LIKE '%hu-mgu_01%'
                THEN 'MGU'
            WHEN TRIM({fallback_project_expr}) <> ''
                THEN TRIM({fallback_project_expr})
            ELSE 'Unknown'
        END
    """.format(
        name_expr=name_expr,
        target_ecu_conf_expr=target_ecu_conf_expr,
        top_aida_expr=top_aida_expr,
        fallback_project_expr=fallback_project_expr,
    )


def build_iso_test_week_sql_expr(*, finished_expr: str, fallback_test_week_expr: str) -> str:
    thursday_expr = "date({finished_expr}, '-3 days', 'weekday 4')".format(
        finished_expr=finished_expr,
    )
    return """
        CASE
            WHEN TRIM({finished_expr}) <> ''
                THEN (
                    strftime('%Y', {thursday_expr})
                    || '-CW'
                    || printf(
                        '%02d',
                        CAST(((CAST(strftime('%j', {thursday_expr}) AS INTEGER) - 1) / 7) + 1 AS INTEGER)
                    )
                )
            WHEN TRIM({fallback_test_week_expr}) <> ''
                THEN TRIM({fallback_test_week_expr})
            ELSE ''
        END
    """.format(
        finished_expr=finished_expr,
        thursday_expr=thursday_expr,
        fallback_test_week_expr=fallback_test_week_expr,
    )
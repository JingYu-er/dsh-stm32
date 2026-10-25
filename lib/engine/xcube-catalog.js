/**
 * X-CUBE / I-CUBE 第三方包目录（快照）。
 *
 * 由 scripts/gen-xcube-catalog.mjs 从 CubeMX 的包索引目录生成，不要手改；想要最新的目录，重跑一次生成脚本。
 *
 * 来源：CubeMX 包索引 ~/.stm32cubemx/thirdparties/pdsc（159 个 .pdsc）
 * 生成时间：2026-10-24T03:04:36.542Z
 * 索引文件数：159（一个包的每个版本各占一个 .pdsc，所以文件数恒 ≥ 归并后的条目数；条目数看 XCUBE_CATALOG_ENTRY_COUNT）
 *
 * 用途：.ioc 里第三方包的身份有两种写法，都靠这张表认出来 ——
 *   Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0
 *   STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.IPParameters=...
 * 有了目录才能判断这个工程到底用不用第三方包，进而决定 thirdparties/pdsc 要不要加载。
 */
/**
 * 生成这份快照时 CubeMX 包索引目录里的 .pdsc 文件数。
 * 它和下面的条目数不是一回事：一个包有多个版本就多个文件，归并后只算一条，所以它 > 条目数。
 */
export const XCUBE_CATALOG_FILE_COUNT = 159;
/** 生成时间（ISO 字符串）。 */
export const XCUBE_CATALOG_GENERATED_AT = "2026-10-24T03:04:36.542Z";
export const XCUBE_PACK_CATALOG = [
    { vendor: "Avnet-IOTCONNECT", name: "X-CUBE-iotc-st67-sdk", versions: ["1.0.0"] },
    { vendor: "Cesanta", name: "I-CUBE-Mongoose", versions: ["7.19.0"] },
    { vendor: "EmbeddedOffice", name: "I-CUBE-FS-RTOS", versions: ["1.0.1"] },
    { vendor: "emotas", name: "I-CUBE-CANOPEN", versions: ["1.3.0"] },
    { vendor: "Infineon", name: "AIROC-Wi-Fi-Bluetooth-STM32", versions: ["1.7.1"] },
    { vendor: "ITTIA_DB", name: "I-CUBE-ITTIADB", versions: ["8.9.0"] },
    { vendor: "quantropi", name: "X-CUBE-qispace-sdk-base", versions: ["2.1.0"] },
    { vendor: "RealThread", name: "X-CUBE-RT-Thread_Nano", versions: ["4.1.1"] },
    { vendor: "SEGGER", name: "I-CUBE-embOS", versions: ["1.3.1"] },
    { vendor: "STMicroelectronics", name: "eDS-WB_DPC_3PH2L-BIDIR", versions: ["1.1.1"] },
    { vendor: "STMicroelectronics", name: "eDS-WB_DPC_TT-BIDIR", versions: ["2.1.1"] },
    { vendor: "STMicroelectronics", name: "eDS-WB_DPC_VIENNA", versions: ["1.2.0"] },
    { vendor: "STMicroelectronics", name: "FP-ATR-ASTRA1", versions: ["2.0.2", "2.0.3"] },
    { vendor: "STMicroelectronics", name: "FP-ATR-SIGFOX1", versions: ["3.2.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-FLIGHT1", versions: ["5.1.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-MOTENV1", versions: ["5.1.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-MOTENVWB1", versions: ["1.4.0", "1.5.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-SMARTAG2", versions: ["1.2.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-STAIOTCFT", versions: ["1.0.0", "1.1.0", "2.0.0"] },
    { vendor: "STMicroelectronics", name: "FP-SNS-STBOX1", versions: ["2.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AI", versions: ["10.2.0", "10.2.1"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-ALGOBUILD", versions: ["1.4.0", "1.5.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-ALS", versions: ["1.0.2"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-F4", versions: ["1.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-F7", versions: ["1.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-G0", versions: ["1.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-G4", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-H7", versions: ["3.4.0", "3.5.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-H7RS", versions: ["1.1.0", "1.2.0", "1.3.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-L4", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-L5", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-WB", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-AZRTOS-WL", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-BLE1", versions: ["7.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-BLE2", versions: ["3.3.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-BLEMGR", versions: ["4.1.0", "4.2.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-DISPLAY", versions: ["3.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-DPower", versions: ["1.3.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-EEPRMA1", versions: ["5.2.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-FREERTOS", versions: ["1.3.1", "1.4.0", "1.5.0", "1.6.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-GNSS1", versions: ["7.1.0", "7.1.1"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-IPS", versions: ["3.2.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-ISPU", versions: ["2.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-MEMS1", versions: ["11.3.0", "12.0.0", "12.1.0", "13.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC10", versions: ["1.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC12", versions: ["1.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC13", versions: ["1.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC4", versions: ["3.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC6", versions: ["3.1.0", "3.2.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC7", versions: ["2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-NFC9", versions: ["1.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-PM33A1", versions: ["1.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-SFXS2LP1", versions: ["4.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-SMBUS", versions: ["2.1.0", "2.1.1"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-ST60", versions: ["1.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-ST67W61", versions: ["1.1.0", "1.2.0", "1.3.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-STSE01", versions: ["1.0.0", "2.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-SUBG2", versions: ["5.0.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-TCPP", versions: ["4.2.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-TOF1", versions: ["3.4.3"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-TOUCHGFX", versions: ["4.26.0", "4.26.1", "4.27.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-WB05N", versions: ["2.0.0", "2.1.0"] },
    { vendor: "STMicroelectronics", name: "X-CUBE-WBA", versions: ["1.1.0"] },
    { vendor: "wolfSSL", name: "I-CUBE-wolfMQTT", versions: ["1.19.2"] },
    { vendor: "wolfSSL", name: "I-CUBE-wolfSSH", versions: ["1.4.20"] },
    { vendor: "wolfSSL", name: "I-CUBE-wolfSSL", versions: ["5.8.2"] },
    { vendor: "wolfSSL", name: "I-CUBE-wolfTPM", versions: ["3.8.0"] },
];
/**
 * 快照里的包条目数（归并后）。
 * 由数组长度派生而不是另写一个常量：手写的数字迟早会和数组对不上，
 * 报告里就会出现"收录 159 条"但实际只能匹配 67 条的自相矛盾（审计 A23）。
 */
export const XCUBE_CATALOG_ENTRY_COUNT = XCUBE_PACK_CATALOG.length;
/** 快照来源（进报告 notes，便于判断新旧）。两个数字都从上面的常量派生，重跑生成脚本不会漂。 */
export const XCUBE_CATALOG_SOURCE = "CubeMX 包索引 ~/.stm32cubemx/thirdparties/pdsc（上游 "
    + String(XCUBE_CATALOG_FILE_COUNT)
    + " 个 .pdsc，归并成 "
    + String(XCUBE_CATALOG_ENTRY_COUNT)
    + " 个包）";

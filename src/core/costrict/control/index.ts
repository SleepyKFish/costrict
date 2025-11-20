import * as vscode from "vscode"
import { ClineProvider } from "../../webview/ClineProvider"
import { getCommand } from "../../../utils/commands"
import { CostrictCommandId } from "@roo-code/types"
import { getVisibleProviderOrLog } from "../../../activate/registerCommands"
import { ControlService } from "./controlService"

/**
 * 初始化 Control 功能
 * @param context VSCode 扩展上下文
 * @param provider ClineProvider 实例
 * @param outputChannel 输出通道
 */
export function initControl(
	context: vscode.ExtensionContext,
	provider: ClineProvider,
	outputChannel: vscode.OutputChannel,
) {
	const controlService = ControlService.getInstance()
	controlService.setProvider(provider)

	const commandMap: Partial<Record<CostrictCommandId, any>> = {
		// Control 按钮点击 - 进入 Control 模式
		controlButtonClicked: async () => {
			let visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				visibleProvider = await ClineProvider.getInstance()
			}

			if (!visibleProvider) {
				return
			}

			// 通知 webview 切换到 Control 界面
			visibleProvider.postMessageToWebview({ type: "action", action: "controlButtonClicked" })
		},

		// 开始 Control 任务
		startControlTask: async (userPrompt: string) => {
			const visibleProvider = await ClineProvider.getInstance()
			if (!visibleProvider) {
				return
			}

			controlService.setProvider(visibleProvider)

			try {
				await controlService.startControlTask(userPrompt)
			} catch (error) {
				vscode.window.showErrorMessage(
					`Control 任务失败: ${error instanceof Error ? error.message : String(error)}`,
				)
				visibleProvider.log(`[Control] Task failed: ${error}`)
			}
		},

		// 取消 Control 任务
		cancelControlTask: async () => {
			controlService.cancelTask()
		},

		// 重置 Control 状态
		resetControl: async () => {
			controlService.reset()
		},
	}

	// 注册所有命令
	for (const [id, callback] of Object.entries(commandMap)) {
		const command = getCommand(id as CostrictCommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

// 导出类型和服务
export { ControlService } from "./controlService"
export * from "./types"

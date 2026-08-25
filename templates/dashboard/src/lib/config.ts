/**
 * AgentFactory Configuration
 *
 * Central route wiring — connects your callbacks to the route factories.
 * Customize generatePrompt and other hooks to match your workflow.
 */

import { createAllRoutes, createDefaultLinearClientResolver } from '@donmai/nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
  // Uncomment and customize as needed:
  // projects: ['MyProject'],  // Only handle webhooks for these Linear projects
  // generatePrompt: (identifier, workType, mentionContext) => {
  //   return `Work on issue ${identifier} (type: ${workType})`
  // },
  // autoTrigger: {
  //   enableAutoQA: true,
  //   enableAutoAcceptance: false,
  //   autoQARequireAgentWorked: true,
  //   autoAcceptanceRequireAgentWorked: true,
  //   autoQAProjects: [],
  //   autoAcceptanceProjects: [],
  //   autoQAExcludeLabels: [],
  //   autoAcceptanceExcludeLabels: [],
  // },
})

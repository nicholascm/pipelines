"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const azdev = __importStar(require("azure-devops-node-api"));
const task_parameters_1 = require("./task.parameters");
const pipeline_error_1 = require("./pipeline.error");
const ReleaseInterfaces = __importStar(require("azure-devops-node-api/interfaces/ReleaseInterfaces"));
const BuildInterfaces = __importStar(require("azure-devops-node-api/interfaces/BuildInterfaces"));
const pipeline_helper_1 = require("./util/pipeline.helper");
const logger_1 = require("./util/logger");
const url_parser_1 = require("./util/url.parser");
class PipelineRunner {
    constructor(taskParameters) {
        this.repository = pipeline_helper_1.PipelineHelper.processEnv("GITHUB_REPOSITORY");
        this.branch = pipeline_helper_1.PipelineHelper.processEnv("GITHUB_REF");
        this.commitId = pipeline_helper_1.PipelineHelper.processEnv("GITHUB_SHA");
        this.githubRepo = "GitHub";
        this.taskParameters = taskParameters;
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                var taskParams = task_parameters_1.TaskParameters.getTaskParams();
                let authHandler = azdev.getPersonalAccessTokenHandler(taskParams.azureDevopsToken);
                let collectionUrl = url_parser_1.UrlParser.GetCollectionUrlBase(this.taskParameters.azureDevopsProjectUrl);
                core.info(`Creating connection with Azure DevOps service : "${collectionUrl}"`);
                let webApi = new azdev.WebApi(collectionUrl, authHandler);
                core.info("Connection created");
                let description = `(name="${this.taskParameters.azurePipelineName}", id=${this.taskParameters.azurePipelineId})`;
                try {
                    core.debug(`Triggering Yaml pipeline : ${description}`);
                    yield this.RunYamlPipeline(webApi);
                }
                catch (error) {
                    if (error instanceof pipeline_error_1.PipelineNotFoundError) {
                        core.debug(`Triggering Designer pipeline : ${description}`);
                        yield this.RunDesignerPipeline(webApi);
                    }
                    else {
                        throw error;
                    }
                }
            }
            catch (error) {
                let errorMessage = `${error.message}`;
                core.setFailed(errorMessage);
            }
        });
    }
    RunYamlPipeline(webApi) {
        return __awaiter(this, void 0, void 0, function* () {
            let projectName = url_parser_1.UrlParser.GetProjectName(this.taskParameters.azureDevopsProjectUrl);
            let pipelineName = this.taskParameters.azurePipelineName;
            let buildDefinitionId = this.taskParameters.azurePipelineId ? parseInt(this.taskParameters.azurePipelineId, 10) : 0;
            let buildApi = yield webApi.getBuildApi();
            // If the user passed a name instead of a definition id, search existing
            // pipelines for that id.
            if (!buildDefinitionId) {
                // Get matching build definitions for the given project and pipeline name
                const buildDefinitions = yield buildApi.getDefinitions(projectName, pipelineName);
                pipeline_helper_1.PipelineHelper.EnsureValidPipeline(projectName, pipelineName, buildDefinitions);
                // Extract Id from build definition
                let buildDefinitionReference = buildDefinitions[0];
                pipelineName = buildDefinitionReference.name;
                buildDefinitionId = buildDefinitionReference.id;
            }
            // Get build definition for the matching definition Id
            let buildDefinition = yield buildApi.getDefinition(projectName, buildDefinitionId);
            logger_1.Logger.LogPipelineObject(buildDefinition);
            // Fetch repository details from build definition
            let repositoryId = buildDefinition.repository.id.trim();
            let repositoryType = buildDefinition.repository.type.trim();
            let sourceBranch = null;
            let sourceVersion = null;
            // If definition is linked to existing github repo, pass github source branch and source version to build
            if (pipeline_helper_1.PipelineHelper.equals(repositoryId, this.repository) && pipeline_helper_1.PipelineHelper.equals(repositoryType, this.githubRepo)) {
                core.debug("pipeline is linked to same Github repo");
                sourceBranch = this.branch,
                    sourceVersion = this.commitId;
            }
            else {
                core.debug("pipeline is not linked to same Github repo");
            }
            // If provided, the user-specified ref and sha override our implied branch
            // and commit hash from GitHub. This is useful when we're using this action
            // in workflows triggered by non-PR events (like issue_comment).
            if (this.taskParameters.ref) {
                sourceBranch = this.taskParameters.ref;
                core.debug(`using user-specified ref ${sourceBranch}`);
            }
            if (this.taskParameters.sha) {
                sourceVersion = this.taskParameters.sha;
                core.debug(`using user-specified sha ${sourceVersion}`);
            }
            let build = {
                definition: {
                    id: buildDefinition.id
                },
                project: {
                    id: buildDefinition.project.id
                },
                sourceBranch: sourceBranch,
                sourceVersion: sourceVersion,
                reason: BuildInterfaces.BuildReason.Triggered
            };
            logger_1.Logger.LogPipelineTriggerInput(build);
            // Queue build
            let buildQueueResult = yield buildApi.queueBuild(build, build.project.id, true);
            if (buildQueueResult != null) {
                logger_1.Logger.LogPipelineTriggerOutput(buildQueueResult);
                // If build result contains validation errors set result to FAILED
                if (buildQueueResult.validationResults != null && buildQueueResult.validationResults.length > 0) {
                    let errorAndWarningMessage = pipeline_helper_1.PipelineHelper.getErrorAndWarningMessageFromBuildResult(buildQueueResult.validationResults);
                    core.setFailed("Errors: " + errorAndWarningMessage.errorMessage + " Warnings: " + errorAndWarningMessage.warningMessage);
                }
                else {
                    logger_1.Logger.LogPipelineTriggered(pipelineName, projectName);
                    if (buildQueueResult._links != null) {
                        logger_1.Logger.LogOutputUrl(buildQueueResult._links.web.href);
                    }
                }
            }
        });
    }
    RunDesignerPipeline(webApi) {
        return __awaiter(this, void 0, void 0, function* () {
            let projectName = url_parser_1.UrlParser.GetProjectName(this.taskParameters.azureDevopsProjectUrl);
            let pipelineName = this.taskParameters.azurePipelineName;
            let releaseApi = yield webApi.getReleaseApi();
            // Get release definitions for the given project name and pipeline name
            const releaseDefinitions = yield releaseApi.getReleaseDefinitions(projectName, pipelineName, ReleaseInterfaces.ReleaseDefinitionExpands.Artifacts);
            pipeline_helper_1.PipelineHelper.EnsureValidPipeline(projectName, pipelineName, releaseDefinitions);
            let releaseDefinition = releaseDefinitions[0];
            logger_1.Logger.LogPipelineObject(releaseDefinition);
            // Filter Github artifacts from release definition
            let gitHubArtifacts = releaseDefinition.artifacts.filter(pipeline_helper_1.PipelineHelper.isGitHubArtifact);
            let artifacts = new Array();
            if (gitHubArtifacts == null || gitHubArtifacts.length == 0) {
                core.debug("Pipeline is not linked to any GitHub artifact");
                // If no GitHub artifacts found it means pipeline is not linked to any GitHub artifact
            }
            else {
                // If pipeline has any matching Github artifact
                core.debug("Pipeline is linked to GitHub artifact. Looking for now matching repository");
                gitHubArtifacts.forEach(gitHubArtifact => {
                    if (gitHubArtifact.definitionReference != null && pipeline_helper_1.PipelineHelper.equals(gitHubArtifact.definitionReference.definition.name, this.repository)) {
                        // Add version information for matching GitHub artifact
                        let artifactMetadata = {
                            alias: gitHubArtifact.alias,
                            instanceReference: {
                                id: this.commitId,
                                sourceBranch: this.branch,
                                sourceRepositoryType: this.githubRepo,
                                sourceRepositoryId: this.repository,
                                sourceVersion: this.commitId
                            }
                        };
                        core.debug("pipeline is linked to same Github repo");
                        artifacts.push(artifactMetadata);
                    }
                });
            }
            let releaseStartMetadata = {
                definitionId: releaseDefinition.id,
                reason: ReleaseInterfaces.ReleaseReason.ContinuousIntegration,
                artifacts: artifacts
            };
            logger_1.Logger.LogPipelineTriggerInput(releaseStartMetadata);
            // create release
            let release = yield releaseApi.createRelease(releaseStartMetadata, projectName);
            if (release != null) {
                logger_1.Logger.LogPipelineTriggered(pipelineName, projectName);
                logger_1.Logger.LogPipelineTriggerOutput(release);
                if (release != null && release._links != null) {
                    logger_1.Logger.LogOutputUrl(release._links.web.href);
                }
            }
        });
    }
}
exports.PipelineRunner = PipelineRunner;

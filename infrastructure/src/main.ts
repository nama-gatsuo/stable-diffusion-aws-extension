import { App, Aspects, Aws, CfnCondition, CfnOutput, CfnParameter, Fn, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { CfnRestApi } from 'aws-cdk-lib/aws-apigateway';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BootstraplessStackSynthesizer, CompositeECRRepositoryAspect } from 'cdk-bootstrapless-synthesizer';
import { Construct } from 'constructs';
import { PingApi } from './api/service/ping';
import { CheckpointStack } from './checkpoints/checkpoint-stack';
import { ComfyApiStack, ComfyInferenceStackProps } from './comfy/comfy-api-stack';
import { ComfyDatabase } from './comfy/comfy-database';
import { ECR_IMAGE_TAG } from './common/dockerImageTag';
import { LambdaCommonLayer } from './shared/common-layer';
import { STACK_ID } from './shared/const';
import { Database } from './shared/database';
import { DatasetStack } from './shared/dataset';
import { Inference } from './shared/inference';
import { MultiUsers } from './shared/multi-users';
import { ResourceProvider } from './shared/resource-provider';
import { ResourceWaiter } from './shared/resource-waiter';
import { RestApiGateway } from './shared/rest-api-gateway';
import { SnsTopics } from './shared/sns-topics';
import { TrainDeploy } from './shared/train-deploy';

const app = new App();

export class Middleware extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps = {
      // env: devEnv,
      synthesizer: synthesizer(),
    },
  ) {
    super(scope, id, props);
    this.templateOptions.description = '(SO8032) - Stable-Diffusion AWS Extension';

    const apiKeyParam = new CfnParameter(this, 'SdExtensionApiKey', {
      type: 'String',
      description: 'Enter a string of 20 characters that includes a combination of alphanumeric characters',
      allowedPattern: '[A-Za-z0-9]+',
      minLength: 20,
      maxLength: 20,
      // API Key value should be at least 20 characters
      default: '09876543210987654321',
    });

    // Create CfnParameters here
    const s3BucketName = new CfnParameter(this, 'Bucket', {
      type: 'String',
      description: 'New bucket name or Existing Bucket name',
      minLength: 3,
      maxLength: 63,
      // Bucket naming rules: https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
      allowedPattern: '^(?!.*\\.\\.)(?!xn--)(?!sthree-)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\\.$)(?!.*^\\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$',
    });

    const emailParam = new CfnParameter(this, 'Email', {
      type: 'String',
      description: 'Email address to receive notifications',
      allowedPattern: '\\w[-\\w.+]*@([A-Za-z0-9][-A-Za-z0-9]+\\.)+[A-Za-z]{2,14}',
      default: 'example@example.com',
    });

    const logLevel = new CfnParameter(this, 'LogLevel', {
      type: 'String',
      description: 'Log level, example: ERROR|INFO|DEBUG',
      default: 'ERROR',
      allowedValues: ['ERROR', 'INFO', 'DEBUG'],
    });

    const ecrImageTagParam = new CfnParameter(this, 'EcrImageTag', {
      type: 'String',
      description: 'Inference ECR Image tag',
      default: ECR_IMAGE_TAG,
      allowedValues: [ECR_IMAGE_TAG],
    });

    const isChinaCondition = new CfnCondition(this, 'IsChina', { expression: Fn.conditionEquals(Aws.PARTITION, 'aws-cn') });

    const accountId = Fn.conditionIf(
      isChinaCondition.logicalId,
      '753680513547',
      '366590864501',
    );

    // Create resources here

    // The solution currently does not support multi-region deployment, which makes it easy to failure.
    // Therefore, this resource is prioritized to save time.

    const resourceProvider = new ResourceProvider(
      this,
      'ResourcesProvider',
      {
        // when props updated, resource manager will be executed
        // ecrImageTag is not used in the resource manager
        // but if it changes, the resource manager will be executed with 'Update'
        // if the resource manager is executed, it will recheck and create resources for stack
        bucketName: s3BucketName.valueAsString,
        ecrImageTag: ecrImageTagParam.valueAsString,
      },
    );

    const s3Bucket = <Bucket>Bucket.fromBucketName(
      this,
      'aigc-bucket',
      resourceProvider.bucketName,
    );

    const ddbTables = new Database(this, 'sd-ddb');

    const commonLayers = new LambdaCommonLayer(this, 'sd-common-layer', '../middleware_api/lambda');

    const restApi = new RestApiGateway(this, apiKeyParam.valueAsString, [
      'ping',
      // sd api
      'checkpoints',
      'datasets',
      'users',
      'roles',
      'endpoints',
      'inferences',
      'trainings',
      // comfy api
      'template',
      'model',
      'execute',
      'node',
      'config',
      'endpoint',
      'sync',
    ]);
    const cfnApi = restApi.apiGateway.node.defaultChild as CfnRestApi;
    cfnApi.addPropertyOverride('EndpointConfiguration', {
      Types: [Fn.conditionIf(isChinaCondition.logicalId, 'REGIONAL', 'EDGE').toString()],
    });

    new MultiUsers(this, {
      synthesizer: props.synthesizer,
      commonLayer: commonLayers.commonLayer,
      multiUserTable: ddbTables.multiUserTable,
      routers: restApi.routers,
      logLevel,
    });

    new PingApi(this, 'Ping', {
      commonLayer: commonLayers.commonLayer,
      httpMethod: 'GET',
      router: restApi.routers.ping,
      srcRoot: '../middleware_api/lambda',
      logLevel,
    });

    const snsTopics = new SnsTopics(this, 'sd-sns', emailParam);

    new Inference(this, {
      routers: restApi.routers,
      s3_bucket: s3Bucket,
      training_table: ddbTables.trainingTable,
      snsTopic: snsTopics.snsTopic,
      sd_inference_job_table: ddbTables.sDInferenceJobTable,
      sd_endpoint_deployment_job_table: ddbTables.sDEndpointDeploymentJobTable,
      checkpointTable: ddbTables.checkpointTable,
      multiUserTable: ddbTables.multiUserTable,
      commonLayer: commonLayers.commonLayer,
      synthesizer: props.synthesizer,
      inferenceErrorTopic: snsTopics.inferenceResultErrorTopic,
      inferenceResultTopic: snsTopics.inferenceResultTopic,
      accountId,
      logLevel,
      resourceProvider,
    });

    new CheckpointStack(this, {
      // env: devEnv,
      synthesizer: props.synthesizer,
      checkpointTable: ddbTables.checkpointTable,
      multiUserTable: ddbTables.multiUserTable,
      routers: restApi.routers,
      s3Bucket: s3Bucket,
      commonLayer: commonLayers.commonLayer,
      logLevel: logLevel,
    });

    const ddbComfyTables = new ComfyDatabase(this, 'comfy-ddb');

    const apis = new ComfyApiStack(this, 'comfy-api', <ComfyInferenceStackProps>{
      routers: restApi.routers,
      // env: devEnv,
      s3Bucket: s3Bucket,
      ecrImageTag: ecrImageTagParam,
      configTable: ddbComfyTables.configTable,
      executeTable: ddbComfyTables.executeTable,
      syncTable: ddbComfyTables.syncTable,
      msgTable: ddbComfyTables.msgTable,
      multiUserTable: ddbTables.multiUserTable,
      endpointTable: ddbTables.sDEndpointDeploymentJobTable,
      instanceMonitorTable: ddbComfyTables.instanceMonitorTable,
      commonLayer: commonLayers.commonLayer,
      executeSuccessTopic: snsTopics.executeResultSuccessTopic,
      executeFailTopic: snsTopics.executeResultFailTopic,
      logLevel: logLevel,
      accountId: accountId,
    });
    apis.node.addDependency(ddbComfyTables);

    const train = new TrainDeploy(this, {
      commonLayer: commonLayers.commonLayer,
      synthesizer: props.synthesizer,
      database: ddbTables,
      routers: restApi.routers,
      s3Bucket: s3Bucket,
      snsTopic: snsTopics.snsTopic,
      logLevel,
      resourceProvider,
      accountId,
    });

    new DatasetStack(this, {
      commonLayer: commonLayers.commonLayer,
      synthesizer: props.synthesizer,
      database: ddbTables,
      routers: restApi.routers,
      s3Bucket: s3Bucket,
      logLevel,
    });

    const resourceWaiter = new ResourceWaiter(
      this,
      'ResourcesWaiter',
      {
        resourceProvider: resourceProvider,
        restApiGateway: restApi,
        apiKeyParam: apiKeyParam,
      },
    );
    resourceWaiter.node.addDependency(train.deleteTrainingJobsApi.requestValidator);

    // Add ResourcesProvider dependency to all resources
    for (const resource of this.node.children) {
      if (!resourceProvider.instanceof(resource)) {
        resource.node.addDependency(resourceProvider.resources);
      }
    }

    // Add stackName tag to all resources
    const stackName = Stack.of(this).stackName;
    Tags.of(this).add('stackName', stackName);

    // Adding Outputs for apiGateway and s3Bucket
    new CfnOutput(this, 'ApiGatewayUrl', {
      value: restApi.apiGateway.url,
      description: 'API Gateway URL',
    });

    new CfnOutput(this, 'ApiGatewayUrlToken', {
      value: apiKeyParam.valueAsString,
      description: 'API Gateway Token',
    });

    new CfnOutput(this, 'S3BucketName', {
      value: s3Bucket.bucketName,
      description: 'S3 Bucket Name',
    });

    new CfnOutput(this, 'SNSTopicName', {
      value: snsTopics.snsTopic.topicName,
      description: 'SNS Topic Name to get train and inference result notification',
    });
  }
}

new Middleware(
  app,
  STACK_ID,
  {
    // env: devEnv,
    synthesizer: synthesizer(),
  },
);

app.synth();
// below lines are required if your application has Docker assets
if (process.env.USE_BSS) {
  Aspects.of(app).add(new CompositeECRRepositoryAspect());
}

function synthesizer() {
  return process.env.USE_BSS
    ? new BootstraplessStackSynthesizer()
    : undefined;
}

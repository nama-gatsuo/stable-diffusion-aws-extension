import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Aws, aws_apigateway, aws_dynamodb, aws_iam, aws_lambda, aws_s3, Duration } from 'aws-cdk-lib';
import { JsonSchemaType, JsonSchemaVersion, Model } from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Effect } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Size } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ApiModels } from '../../shared/models';
import { SCHEMA_DEBUG, SCHEMA_MESSAGE } from '../../shared/schema';

export interface StartInferenceJobApiProps {
  router: aws_apigateway.Resource;
  httpMethod: string;
  endpointDeploymentTable: aws_dynamodb.Table;
  inferenceJobTable: aws_dynamodb.Table;
  checkpointTable: aws_dynamodb.Table;
  userTable: aws_dynamodb.Table;
  s3Bucket: aws_s3.Bucket;
  commonLayer: aws_lambda.LayerVersion;
}

export class StartInferenceJobApi {

  private readonly id: string;
  private readonly scope: Construct;
  private readonly layer: aws_lambda.LayerVersion;
  private readonly s3Bucket: aws_s3.Bucket;
  private readonly httpMethod: string;
  private readonly router: aws_apigateway.Resource;
  private readonly endpointDeploymentTable: aws_dynamodb.Table;
  private readonly inferenceJobTable: aws_dynamodb.Table;
  private readonly checkpointTable: aws_dynamodb.Table;
  private readonly userTable: aws_dynamodb.Table;

  constructor(scope: Construct, id: string, props: StartInferenceJobApiProps) {
    this.id = id;
    this.scope = scope;
    this.endpointDeploymentTable = props.endpointDeploymentTable;
    this.router = props.router;
    this.inferenceJobTable = props.inferenceJobTable;
    this.checkpointTable = props.checkpointTable;
    this.userTable = props.userTable;
    this.layer = props.commonLayer;
    this.s3Bucket = props.s3Bucket;
    this.httpMethod = props.httpMethod;

    const lambdaFunction = this.apiLambda();

    const lambdaIntegration = new aws_apigateway.LambdaIntegration(
      lambdaFunction,
      {
        proxy: true,
      },
    );

    this.router.addResource('start')
      .addMethod(this.httpMethod, lambdaIntegration, {
        apiKeyRequired: true,
        operationName: 'StartInferences',
        methodResponses: [
          ApiModels.methodResponse(this.responseModel(), '202'),
          ApiModels.methodResponses401(),
          ApiModels.methodResponses403(),
          ApiModels.methodResponses404(),
        ],
      });

  }

  private responseModel() {
    return new Model(this.scope, `${this.id}-resp-model`, {
      restApi: this.router.api,
      modelName: 'StartInferenceJobResponse',
      description: 'StartInferenceJob Response Model',
      schema: {
        schema: JsonSchemaVersion.DRAFT7,
        title: this.id,
        type: JsonSchemaType.OBJECT,
        properties: {
          statusCode: {
            type: JsonSchemaType.NUMBER,
          },
          debug: SCHEMA_DEBUG,
          message: SCHEMA_MESSAGE,
          data: {
            type: JsonSchemaType.OBJECT,
            properties: {
              inference: {
                type: JsonSchemaType.OBJECT,
                properties: {
                  inference_id: {
                    type: JsonSchemaType.STRING,
                    format: 'uuid',
                  },
                  status: {
                    type: JsonSchemaType.STRING,
                  },
                  endpoint_name: {
                    type: JsonSchemaType.STRING,
                  },
                  output_path: {
                    type: JsonSchemaType.STRING,
                    format: 'uri',
                  },
                },
                required: [
                  'inference_id',
                  'status',
                  'endpoint_name',
                  'output_path',
                ],
                additionalProperties: false,
              },
            },
            required: [
              'inference',
            ],
            additionalProperties: false,
          },
        },
        required: [
          'statusCode',
          'debug',
          'data',
          'message',
        ],
        additionalProperties: false,
      },
      contentType: 'application/json',
    });
  }


  private getLambdaRole(): aws_iam.Role {
    const newRole = new aws_iam.Role(this.scope, `${this.id}-role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    newRole.addToPolicy(new aws_iam.PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'dynamodb:BatchGetItem',
        'dynamodb:GetItem',
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:BatchWriteItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ],
      resources: [
        this.inferenceJobTable.tableArn,
        this.endpointDeploymentTable.tableArn,
        this.checkpointTable.tableArn,
        this.userTable.tableArn,
      ],
    }));

    newRole.addToPolicy(new aws_iam.PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'sagemaker:InvokeEndpointAsync',
        'sagemaker:InvokeEndpoint',
      ],
      resources: [`arn:${Aws.PARTITION}:sagemaker:${Aws.REGION}:${Aws.ACCOUNT_ID}:endpoint/*`],
    }));

    newRole.addToPolicy(new aws_iam.PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
        's3:ListBuckets',
        's3:CreateBucket',
      ],
      resources: [
        `${this.s3Bucket.bucketArn}/*`,
        `arn:${Aws.PARTITION}:s3:::*sagemaker*`,
      ],
    }));

    newRole.addToPolicy(new aws_iam.PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'kms:Decrypt',
      ],
      resources: ['*'],
    }));

    return newRole;
  }

  private apiLambda() {
    return new PythonFunction(this.scope, `${this.id}-lambda`, {
      entry: '../middleware_api/inferences',
      architecture: Architecture.X86_64,
      runtime: Runtime.PYTHON_3_10,
      index: 'start_inference_job.py',
      handler: 'handler',
      memorySize: 3070,
      tracing: aws_lambda.Tracing.ACTIVE,
      ephemeralStorageSize: Size.gibibytes(10),
      timeout: Duration.seconds(900),
      role: this.getLambdaRole(),
      environment: {
        INFERENCE_JOB_TABLE: this.inferenceJobTable.tableName,
        CHECKPOINT_TABLE: this.checkpointTable.tableName,
      },
      layers: [this.layer],
    });
  }


}

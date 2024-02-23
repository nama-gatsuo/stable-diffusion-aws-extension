import base64
import io
import json
import logging
import os
from datetime import datetime

import boto3
from PIL import Image
from botocore.exceptions import ClientError

from inferences.start_inference_job import upload_file_to_s3, update_inference_job_table, decode_base64_to_image

s3_resource = boto3.resource('s3')
s3_client = boto3.client('s3')

INFERENCE_JOB_TABLE = os.environ.get('INFERENCE_JOB_TABLE')
DDB_TRAINING_TABLE_NAME = os.environ.get('DDB_TRAINING_TABLE_NAME')
DDB_ENDPOINT_DEPLOYMENT_TABLE_NAME = os.environ.get('DDB_ENDPOINT_DEPLOYMENT_TABLE_NAME')
S3_BUCKET_NAME = os.environ.get('S3_BUCKET')
SNS_TOPIC = os.environ['NOTICE_SNS_TOPIC']

ddb_client = boto3.resource('dynamodb')
inference_table = ddb_client.Table(INFERENCE_JOB_TABLE)
endpoint_deployment_table = ddb_client.Table(DDB_ENDPOINT_DEPLOYMENT_TABLE_NAME)
sns = boto3.client('sns')

logger = logging.getLogger(__name__)
logger.setLevel(os.environ.get('LOG_LEVEL') or logging.ERROR)


def get_bucket_and_key(s3uri):
    pos = s3uri.find('/', 5)
    bucket = s3uri[5: pos]
    key = s3uri[pos + 1:]
    return bucket, key


def get_inference_job(inference_job_id):
    if not inference_job_id:
        logger.error("Invalid inference job id")
        raise ValueError("Inference job id must not be None or empty")

    response = inference_table.get_item(Key={'InferenceJobId': inference_job_id})

    if not response['Item']:
        logger.error(f"Inference job not found with id: {inference_job_id}")
        raise ValueError(f"Inference job not found with id: {inference_job_id}")
    return response['Item']


def get_topic_arn(sns, topic_name):
    response = sns.list_topics()
    for topic in response['Topics']:
        if topic['TopicArn'].split(':')[-1] == topic_name:
            return topic['TopicArn']
    return None


def send_message_to_sns(message_json):
    try:
        sns_topic_arn = get_topic_arn(sns, SNS_TOPIC)
        if sns_topic_arn is None:
            print(f"No topic found with name {SNS_TOPIC}")
            return {
                'statusCode': 404,
                'body': json.dumps('No topic found')
            }

        response = sns.publish(
            TopicArn=sns_topic_arn,
            Message=json.dumps(message_json),
            Subject='Inference Error occurred Information',
        )

        print(f"Message sent to SNS topic: {SNS_TOPIC}")
        return {
            'statusCode': 200,
            'body': json.dumps('Message sent successfully')
        }

    except ClientError as e:
        print(f"Error sending message to SNS topic: {SNS_TOPIC}")
        return {
            'statusCode': 500,
            'body': json.dumps('Error sending message'),
            'error': str(e)
        }


def handler(event, context):
    logger.info(json.dumps(event))

    message = event['Records'][0]['Sns']['Message']
    message = json.loads(message)

    if 'invocationStatus' not in message:
        # maybe a message from SNS for test
        logger.error("Not a valid sagemaker message")
        return

    invocation_status = message["invocationStatus"]
    inference_id = message["inferenceId"]

    update_inference_job_table(inference_id, 'completeTime', str(datetime.now()))

    if invocation_status == "Completed":
        try:
            print(f"Complete invocation!")
            endpoint_name = message["requestParameters"]["endpointName"]
            output_location = message["responseParameters"]["outputLocation"]
            bucket, key = get_bucket_and_key(output_location)
            obj = s3_resource.Object(bucket, key)
            body = obj.get()['Body'].read().decode('utf-8')

            print(f"Sagemaker Out Body: {body}")

            json_body = json.loads(body)
            if json_body is None:
                update_inference_job_table(inference_id, 'status', 'failed')
                message_json = {
                    'InferenceJobId': inference_id,
                    'status': "failed",
                    'reason': "Sagemaker inference invocation completed, but the sagemaker output failed to be parsed as json"
                }
                send_message_to_sns(message_json)
                raise ValueError("body contains invalid JSON")

            # Get the task type
            job = get_inference_job(inference_id)
            task_type = job.get('taskType', 'txt2img')

            if task_type in ["interrogate_clip", "interrogate_deepbooru"]:
                caption = json_body['caption']
                # Update the DynamoDB table for the caption
                inference_table.update_item(
                    Key={
                        'InferenceJobId': inference_id
                    },
                    UpdateExpression='SET caption=:f',
                    ExpressionAttributeValues={
                        ':f': caption,
                    }
                )
            elif task_type in ["txt2img", "img2img"]:
                # save images
                for count, b64image in enumerate(json_body["images"]):
                    output_img_type = None
                    if 'output_img_type' in json_body and json_body['output_img_type']:
                        output_img_type = json_body['output_img_type']
                        logger.info(f"async handle_sagemaker_out: output_img_type is not null, {output_img_type}")
                    if not output_img_type:
                        image = decode_base64_to_image(b64image)
                        output = io.BytesIO()
                        image.save(output, format="PNG")
                        s3_client.put_object(
                            Body=output.getvalue(),
                            Bucket=S3_BUCKET_NAME,
                            Key=f"out/{inference_id}/result/image_{count}.png"
                        )
                    else:
                        gif_data = base64.b64decode(b64image.split(",", 1)[0])
                        if len(output_img_type) == 1 and (output_img_type[0] == 'PNG' or output_img_type[0] == 'TXT'):
                            logger.debug(f'output_img_type len is 1 :{output_img_type[0]} {count}')
                            img_type = 'png'
                        elif len(output_img_type) == 2 and ('PNG' in output_img_type and 'TXT' in output_img_type):
                            logger.debug(f'output_img_type len is 2 :{output_img_type[0]} {output_img_type[1]} {count}')
                            img_type = 'png'
                        else:
                            img_type = 'gif'
                            output_img_type = [element for element in output_img_type if
                                               "TXT" not in element and "PNG" not in element]
                            logger.debug(f'output_img_type new is  :{output_img_type}  {count}')
                            # type set
                            image_count = len(json_body["images"])
                            type_count = len(output_img_type)
                            if image_count % type_count == 0:
                                idx = count % type_count
                                img_type = output_img_type[idx].lower()
                        logger.debug(f'img_type is :{img_type} count is:{count}')
                        s3_client.put_object(
                            Body=gif_data,
                            Bucket=S3_BUCKET_NAME,
                            Key=f"out/{inference_id}/result/image_{count}.{img_type}"
                        )
                    # Update the DynamoDB table
                    inference_table.update_item(
                        Key={
                            'InferenceJobId': inference_id
                        },
                        UpdateExpression='SET image_names = list_append(if_not_exists(image_names, :empty_list), :new_image)',
                        ExpressionAttributeValues={
                            ':new_image': [f"image_{count}.png"],
                            ':empty_list': []
                        }
                    )

                # save parameters
                inference_parameters = {}
                inference_parameters["parameters"] = json_body["parameters"]
                inference_parameters["info"] = json_body["info"]
                inference_parameters["endpoint_name"] = endpoint_name
                inference_parameters["inference_id"] = inference_id
                inference_parameters["sns_info"] = message

                json_file_name = f"/tmp/{inference_id}_param.json"

                with open(json_file_name, "w") as outfile:
                    json.dump(inference_parameters, outfile)

                upload_file_to_s3(json_file_name, S3_BUCKET_NAME, f"out/{inference_id}/result",
                                  f"{inference_id}_param.json")
                update_inference_job_table(inference_id, 'inference_info_name', json_file_name)

                print(f"Complete inference parameters {inference_parameters}")
            elif task_type in ["extra-single-image", "rembg"]:
                if 'image' not in json_body:
                    raise Exception(json_body)

                # image = decode_base64_to_image(json_body["image"]).convert("RGB")
                image = Image.open(io.BytesIO(base64.b64decode(json_body["image"])))
                output = io.BytesIO()
                image.save(output, format="PNG")
                # Upload the image to the S3 bucket
                s3_client.put_object(
                    Body=output.getvalue(),
                    Bucket=S3_BUCKET_NAME,
                    Key=f"out/{inference_id}/result/image.png"
                )
                # Update the DynamoDB table
                inference_table.update_item(
                    Key={
                        'InferenceJobId': inference_id
                    },
                    UpdateExpression='SET image_names = list_append(if_not_exists(image_names, :empty_list), :new_image)',
                    ExpressionAttributeValues={
                        ':new_image': [f"image.png"],
                        ':empty_list': []
                    }
                )

                # save parameters
                inference_parameters = {}
                if task_type == "extra-single-image":
                    inference_parameters["html_info"] = json_body["html_info"]
                inference_parameters["endpoint_name"] = endpoint_name
                inference_parameters["inference_id"] = inference_id
                inference_parameters["sns_info"] = message

                json_file_name = f"/tmp/{inference_id}_param.json"

                with open(json_file_name, "w") as outfile:
                    json.dump(inference_parameters, outfile)

                upload_file_to_s3(json_file_name, S3_BUCKET_NAME, f"out/{inference_id}/result",
                                  f"{inference_id}_param.json")
                update_inference_job_table(inference_id, 'inference_info_name', json_file_name)

                print(f"Complete inference parameters {inference_parameters}")

            update_inference_job_table(inference_id, 'status', 'succeed')
            update_inference_job_table(inference_id, 'sagemakerRaw', str(message))
        except Exception as e:
            print(f"Error occurred: {str(e)}")
            update_inference_job_table(inference_id, 'status', 'failed')
            update_inference_job_table(inference_id, 'sagemakerRaw', json.dumps(message))
            raise e
    else:
        update_inference_job_table(inference_id, 'status', 'failed')
        update_inference_job_table(inference_id, 'sagemakerRaw', str(message))
        print(f"Not complete invocation!")
        send_message_to_sns(event['Records'][0]['Sns']['Message'])
    return message
